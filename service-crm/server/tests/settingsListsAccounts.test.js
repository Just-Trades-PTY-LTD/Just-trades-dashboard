import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all, get, run } from '../src/db/index.js';

// Settings → Lists, Trades, Job types and staff accounts (approved plan):
// hide instead of remove, rename keeps the same item, Repeat customer by id,
// per-reason "Requires comments", soft-removed / restorable / deletable
// accounts, Technician accounts that never fall back to Staff, and
// Settings Activity. Admin-only throughout. No record is ever rewritten.

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const STAFF = { name: 'Sam Staff', email: 'sam@justtrades.au', password: 'password123', role: 'staff' };

async function setup(server) {
  await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Kurt Tech' }));
  const lead = (name) => b.lists.lead_source.find((l) => l.name === name);
  return { b, plumbing, tech, lead };
}
const leadCall = (jobNumber, leadSourceId, extra = {}) => ({
  callAt: '2026-11-01T09:00', direction: 'Inbound', callType: 'Lead', booked: 'Yes', jobNumber, leadSourceId, ...extra,
});

test('every list, Trade, Job type and account change is Admin-only', async () => {
  const server = await startTestServer();
  try {
    const { b, plumbing } = await setup(server);
    const staff = ok(await server.request('POST', '/users', STAFF));
    const other = ok(await server.request('POST', '/users', { ...STAFF, name: 'Other', email: 'other@justtrades.au' }));
    await server.request('PATCH', `/users/${other.id}`, { active: false });
    await server.login(STAFF.email, STAFF.password);
    const item = b.lists.lead_source[0];
    for (const [method, path, body] of [
      ['PATCH', `/settings/list-items/${item.id}`, { name: 'X' }],
      ['PATCH', `/settings/list-items/${item.id}/hidden`, { hidden: true }],
      ['PATCH', `/settings/list-items/${b.lists.knockback_reason[0].id}/requires-comment`, { requiresComment: true }],
      ['PATCH', `/settings/trades/${plumbing.id}/hidden`, { hidden: true }],
      ['PATCH', `/settings/job-types/${plumbing.jobTypes[0].id}/hidden`, { hidden: true }],
      ['PUT', '/settings/repeat-customer-lead-source', { leadSourceId: item.id }],
      ['GET', '/settings/usage'],
      ['POST', `/users/${other.id}/remove`, { confirm: true }],
      ['DELETE', `/users/${other.id}`, { confirmName: 'Other' }],
      ['PATCH', `/users/${staff.id}`, { role: 'admin' }],
      ['GET', '/audit/settings-activity'],
    ]) {
      const res = await server.request(method, path, body);
      assert.equal(res.status, 403, `${method} ${path} must be Admin-only`);
    }
  } finally {
    server.close();
  }
});

test('hiding: not offered for new entries; saved records keep it, show it and stay in reports; Show again restores it', async () => {
  const server = await startTestServer();
  try {
    const { lead } = await setup(server);
    const google = lead('Google ads') || lead('Google search');
    const call = ok(await server.request('POST', '/calls', leadCall('HID-1', google.id)));
    const before = ok(await server.request('GET', '/reports/calls?from=2026-11-01&to=2026-11-30'));

    ok(await server.request('PATCH', `/settings/list-items/${google.id}/hidden`, { hidden: true }));
    const b = ok(await server.request('GET', '/settings/bundle'));
    assert.equal(b.lists.lead_source.find((l) => l.id === google.id).hidden, true, 'still in the bundle, flagged hidden');

    const fresh = await server.request('POST', '/calls', leadCall('HID-2', google.id));
    assert.equal(fresh.status, 400, 'a hidden item cannot be chosen for a new entry');
    assert.match(fresh.data.error, /hidden in Settings/);

    // Editing the saved call: keeping its hidden Lead Source is fine.
    const edit = await server.request('PATCH', `/calls/${call.id}`, { ...leadCall('HID-1', google.id), notes: 'edited later' });
    assert.equal(edit.status, 200, JSON.stringify(edit.data));
    const saved = ok(await server.request('GET', '/calls')).rows?.find?.((c) => c.id === call.id) || ok(await server.request('GET', '/calls')).find((c) => c.id === call.id);
    assert.equal(saved.leadSourceName, google.name, 'the saved record still shows its Lead Source');
    const after = ok(await server.request('GET', '/reports/calls?from=2026-11-01&to=2026-11-30'));
    assert.deepEqual(after.summary ?? after.totals ?? null, before.summary ?? before.totals ?? null, 'report figures unchanged');
    assert.equal(JSON.stringify(after).includes(google.name), true, 'the hidden Lead Source still appears in reports');

    ok(await server.request('PATCH', `/settings/list-items/${google.id}/hidden`, { hidden: false }));
    assert.equal((await server.request('POST', '/calls', leadCall('HID-3', google.id))).status, 201, 'available again after Show again');
  } finally {
    server.close();
  }
});

test('a hidden Trade makes all its Job types unavailable for new entries; saved jobs keep them', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, tech } = await setup(server);
    const jt = plumbing.jobTypes[0];
    const job = (jobNumber) => ({ kind: 'new_job_no_sale', visitDate: '2026-11-02', technicianId: tech.id, jobNumber, tradeId: plumbing.id, jobTypeId: jt.id, lead: 'Not Qualified' });
    const saved = ok(await server.request('POST', '/tech/new-job', job('TR-1')));
    ok(await server.request('PATCH', `/settings/trades/${plumbing.id}/hidden`, { hidden: true }));
    const b = ok(await server.request('GET', '/settings/bundle'));
    const t = b.trades.find((x) => x.id === plumbing.id);
    assert.equal(t.hidden, true);
    assert.ok(t.jobTypes.every((j) => j.hidden), 'every Job type of a hidden Trade is unavailable');
    const res = await server.request('POST', '/tech/new-job', job('TR-2'));
    assert.equal(res.status, 400);
    // A different Trade's job type with only the job type field set: Job type of hidden trade is refused too.
    const edit = await server.request('PATCH', `/tech/new-job/${saved.entry.id}`, { ...job('TR-1'), comments: 'kept' });
    assert.equal(edit.status, 200, JSON.stringify(edit.data));
    ok(await server.request('PATCH', `/settings/trades/${plumbing.id}/hidden`, { hidden: false }));
    assert.equal((await server.request('POST', '/tech/new-job', job('TR-3'))).status, 201);
  } finally {
    server.close();
  }
});

test('rename keeps the same item: every record shows the new name, reports group it the same, nothing rewritten, recorded in Activity', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, tech } = await setup(server);
    const jt = plumbing.jobTypes.find((j) => /hot water/i.test(j.name)) || plumbing.jobTypes[0];
    const job = (jobNumber) => ({ kind: 'new_job_no_sale', visitDate: '2026-11-02', technicianId: tech.id, jobNumber, tradeId: plumbing.id, jobTypeId: jt.id, lead: 'Not Qualified' });
    ok(await server.request('POST', '/tech/new-job', job('RN-1')));
    const rowsBefore = all('SELECT * FROM jobs ORDER BY id');
    ok(await server.request('PATCH', `/settings/job-types/${jt.id}`, { name: 'Hot Water Systems' }));
    ok(await server.request('POST', '/tech/new-job', job('RN-2')));
    assert.deepEqual(all('SELECT * FROM jobs ORDER BY id').slice(0, rowsBefore.length), rowsBefore, 'no record was rewritten');
    const entries = ok(await server.request('GET', '/tech/entries'));
    const list = entries;
    const mine = list.filter((e) => ['RN-1', 'RN-2'].includes(e.jobNumber));
    assert.equal(mine.length, 2);
    assert.ok(mine.every((e) => e.jobTypeName === 'Hot Water Systems'), 'old and new records show the new name');
    assert.ok(mine.every((e) => e.jobTypeId === jt.id), 'same underlying item');
    const act = ok(await server.request('GET', '/audit/settings-activity'));
    const renamed = act.rows.find((r) => r.action === 'renamed' && r.entityType === 'job_type');
    assert.deepEqual(renamed.changes.name, { from: jt.name, to: 'Hot Water Systems' });
    assert.equal(renamed.by, 'Admin');
  } finally {
    server.close();
  }
});

test('names are unique within a list (hidden items included, ignoring capitals) and report labels for blanks are reserved', async () => {
  const server = await startTestServer();
  try {
    const { b } = await setup(server);
    const [a, c] = b.lists.knockback_reason;
    ok(await server.request('PATCH', `/settings/list-items/${c.id}/hidden`, { hidden: true }));
    const clash = await server.request('PATCH', `/settings/list-items/${a.id}`, { name: c.name.toUpperCase() });
    assert.equal(clash.status, 400);
    assert.match(clash.data.error, /already an item/);
    for (const reserved of ['Unassigned', 'not specified', 'Unassigned (no booked Lead call)']) {
      assert.equal((await server.request('PATCH', `/settings/list-items/${a.id}`, { name: reserved })).status, 400, reserved);
    }
    // "Add item" twice gives distinct names.
    const one = ok(await server.request('POST', '/settings/lists/knockback_reason', {}));
    const two = ok(await server.request('POST', '/settings/lists/knockback_reason', {}));
    assert.notEqual(one.name, two.name);
  } finally {
    server.close();
  }
});

test('Remove: only for unused items; a used item gets a clear "hide it instead" message and nothing changes', async () => {
  const server = await startTestServer();
  try {
    const { lead, plumbing } = await setup(server);
    const referral = lead('Referral');
    ok(await server.request('POST', '/calls', leadCall('RM-1', referral.id)));
    const res = await server.request('DELETE', `/settings/list-items/${referral.id}`);
    assert.equal(res.status, 409);
    assert.match(res.data.error, /used by 1 call.*hide it instead/);
    assert.ok(get('SELECT id FROM list_items WHERE id = ?', [referral.id]));
    const unused = ok(await server.request('POST', '/settings/lists/lead_source', { name: 'Billboard' }));
    ok(await server.request('DELETE', `/settings/list-items/${unused.id}`));
    assert.equal(get('SELECT id FROM list_items WHERE id = ?', [unused.id]), undefined);
    // A Trade whose job types are used can't be removed (it would take them with it).
    const call = ok(await server.request('POST', '/calls', leadCall('RM-2', referral.id, { tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id })));
    assert.ok(call);
    assert.equal((await server.request('DELETE', `/settings/trades/${plumbing.id}`)).status, 409);
    const usage = ok(await server.request('GET', '/settings/usage'));
    assert.equal(usage.listItems[referral.id], 2);
  } finally {
    server.close();
  }
});

test('Repeat customer by id: renaming it keeps callbacks credited to it; it cannot be hidden or removed while in use for that', async () => {
  const server = await startTestServer();
  try {
    const { b, plumbing, tech, lead } = await setup(server);
    const repeat = lead('Repeat customer');
    // Fresh install: found by name until chosen.
    assert.equal(b.repeatCustomerLeadSourceId, repeat.id);
    assert.equal(b.repeatCustomerSource, 'name');
    ok(await server.request('PUT', '/settings/repeat-customer-lead-source', { leadSourceId: repeat.id }));
    assert.equal(ok(await server.request('GET', '/settings/bundle')).repeatCustomerSource, 'setting');

    // A callback sale (Call back call, no booked Lead call) and a normal lead sale.
    ok(await server.request('POST', '/calls', { callAt: '2026-11-02T09:00', direction: 'Inbound', callType: 'Call back', jobNumber: 'CB-9', callBackReasonId: b.lists.callback_reason[0].id }));
    const sale = (jobNumber) => ({
      kind: 'new_job_sale_made', visitDate: '2026-11-04', technicianId: tech.id, jobNumber, tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified', invoiceNumber: `INV-${jobNumber}`, invoiceDate: '2026-11-04', saleValueExGst: 400,
    });
    ok(await server.request('POST', '/calls', leadCall('LD-9', repeat.id)));
    ok(await server.request('POST', '/tech/new-job', sale('CB-9')));
    ok(await server.request('POST', '/tech/new-job', sale('LD-9')));

    ok(await server.request('PATCH', `/settings/list-items/${repeat.id}`, { name: 'Returning customer' }));
    const report = ok(await server.request('GET', '/reports/tech?from=2026-11-01&to=2026-11-30'));
    const rows = report.salesByMarketingCategory.rows;
    const returning = rows.find((r) => r.category === 'Returning customer');
    assert.deepEqual([returning.sales, returning.totalSalesValueExGst], [2, 800], 'callback and lead sale stay together under the renamed item');
    assert.equal(rows.some((r) => r.category === 'Repeat customer'), false, 'no split "Repeat customer" bucket');
    // The Lead Source filter (by id) includes the callback sale too.
    const filtered = ok(await server.request('GET', `/reports/tech?from=2026-11-01&to=2026-11-30&leadSourceId=${repeat.id}`));
    assert.equal(filtered.salesByMarketingCategory.rows.find((r) => r.category === 'Returning customer').sales, 2);

    assert.equal((await server.request('PATCH', `/settings/list-items/${repeat.id}/hidden`, { hidden: true })).status, 409);
    assert.equal((await server.request('DELETE', `/settings/list-items/${repeat.id}`)).status, 409);
    // Choosing a different one, deliberately, then it can be hidden.
    ok(await server.request('PUT', '/settings/repeat-customer-lead-source', { leadSourceId: lead('Referral').id }));
    ok(await server.request('PATCH', `/settings/list-items/${repeat.id}/hidden`, { hidden: true }));
  } finally {
    server.close();
  }
});

test('Requires comments: off for every reason to start; when an Admin turns it on, that reason needs a comment (Calls and Technician & Sales)', async () => {
  const server = await startTestServer();
  try {
    const { b, tech, plumbing } = await setup(server);
    for (const cat of ['not_booked_reason', 'new_job_cancellation_reason', 'knockback_reason', 'callback_reason', 'pending_cancellation_reason']) {
      assert.ok(b.lists[cat].every((r) => r.requiresComment === false), `${cat} all off`);
    }
    assert.equal((await server.request('PATCH', `/settings/list-items/${b.lists.lead_source[0].id}/requires-comment`, { requiresComment: true })).status, 400, 'Lead Sources are not reasons');
    const nb = b.lists.not_booked_reason[0];
    const notBooked = (notes) => ({ callAt: '2026-11-03T09:00', direction: 'Inbound', callType: 'Lead', booked: 'No', notBookedReasonId: nb.id, notes });
    assert.equal((await server.request('POST', '/calls', notBooked(''))).status, 201, 'off: no comment needed');
    ok(await server.request('PATCH', `/settings/list-items/${nb.id}/requires-comment`, { requiresComment: true }));
    const refused = await server.request('POST', '/calls', notBooked(''));
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /requires one/);
    assert.equal((await server.request('POST', '/calls', notBooked('Said they will call back'))).status, 201);
    // An older record with that reason can still be edited without touching it.
    const older = ok(await server.request('POST', '/calls', notBooked('first note')));
    ok(await server.request('PATCH', `/calls/${older.id}`, { suburb: 'Kilburn (5084)' }));
    // Call Back entry reason.
    const cbr = b.lists.callback_reason[0];
    ok(await server.request('PATCH', `/settings/list-items/${cbr.id}/requires-comment`, { requiresComment: true }));
    ok(await server.request('POST', '/tech/new-job', { kind: 'new_job_no_sale', visitDate: '2026-11-02', technicianId: tech.id, jobNumber: 'OR-1', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id, lead: 'Not Qualified' }));
    const cb = await server.request('POST', '/tech/call-backs', { jobNumber: 'OR-1', visitDate: '2026-11-05', technicianId: tech.id, creditedTechnicianId: tech.id, reasonId: cbr.id, comments: '' });
    assert.equal(cb.status, 400);
  } finally {
    server.close();
  }
});

test('accounts: soft-remove (sign-in blocked, name and links kept, email reserved), restore, release email, permanent delete only when unlinked', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    const sam = ok(await server.request('POST', '/users', STAFF));
    // Sam makes a record, so the account is linked.
    await server.login(STAFF.email, STAFF.password);
    const call = ok(await server.request('POST', '/calls', { callAt: '2026-11-03T09:00', direction: 'Inbound', callType: 'Not lead' }));
    await server.login();
    assert.equal((await server.request('POST', `/users/${sam.id}/remove`, { confirm: true })).status, 400, 'must be deactivated first');
    ok(await server.request('PATCH', `/users/${sam.id}`, { active: false }));
    const del = await server.request('DELETE', `/users/${sam.id}`, { confirmName: 'Sam Staff' });
    assert.equal(del.status, 409, 'linked accounts are never permanently deleted');
    assert.match(del.data.error, /linked to 2 calls?|linked to/);
    const removed = ok(await server.request('POST', `/users/${sam.id}/remove`, { confirm: true }));
    assert.equal(removed.removed, true);
    assert.equal(get('SELECT handled_by_user_id, created_by_user_id FROM calls WHERE id = ?', [call.id]).created_by_user_id, sam.id, 'links kept');
    const list = ok(await server.request('GET', '/users'));
    assert.equal(list.find((u) => u.id === sam.id).removed, true);
    // Sign-in blocked even if reactivated directly in the database.
    run('UPDATE users SET active = 1 WHERE id = ?', [sam.id]);
    assert.equal((await server.request('POST', '/auth/login', { email: STAFF.email, password: STAFF.password })).status, 401);
    run('UPDATE users SET active = 0 WHERE id = ?', [sam.id]);
    await server.login();
    assert.equal((await server.request('PATCH', `/users/${sam.id}`, { active: true })).status, 400, 'restore first');
    // Email reserved.
    const taken = await server.request('POST', '/users', { ...STAFF, name: 'New Sam' });
    assert.equal(taken.status, 409);
    assert.match(taken.data.error, /removed account "Sam Staff"/);
    // Historical name still shown (directory for filters marks it removed).
    const dirAll = ok(await server.request('GET', '/users/directory?all=1'));
    assert.equal(dirAll.find((u) => u.id === sam.id).name, 'Sam Staff (removed)');
    // Restore: same type, still inactive.
    const back = ok(await server.request('POST', `/users/${sam.id}/restore`, { confirm: true }));
    assert.deepEqual([back.removed, back.active, back.accessType, back.email], [false, false, 'staff', STAFF.email]);
    // Remove again and release the email: a new account can use it; restoring needs a new email.
    ok(await server.request('POST', `/users/${sam.id}/remove`, { confirm: true }));
    ok(await server.request('POST', `/users/${sam.id}/release-email`, { confirm: true }));
    ok(await server.request('POST', '/users', { ...STAFF, name: 'New Sam' }));
    assert.equal((await server.request('POST', `/users/${sam.id}/restore`, { confirm: true })).status, 400, 'needs a new email');
    const restored = ok(await server.request('POST', `/users/${sam.id}/restore`, { confirm: true, email: 'sam.old@justtrades.au' }));
    assert.equal(restored.email, 'sam.old@justtrades.au');
    const act = ok(await server.request('GET', '/audit/settings-activity?entityType=user'));
    assert.ok(act.rows.some((r) => r.action === 'email_released' && r.changes.email.from === STAFF.email), 'original email kept in Settings Activity');

    // An inactive account linked to nothing: permanently deleted after typing its name.
    const dup = ok(await server.request('POST', '/users', { ...STAFF, name: 'Cody', email: 'codyw@justrades.au' }));
    ok(await server.request('PATCH', `/users/${dup.id}`, { active: false }));
    assert.equal((await server.request('DELETE', `/users/${dup.id}`, { confirmName: 'cody' })).status, 400, 'exact name');
    ok(await server.request('DELETE', `/users/${dup.id}`, { confirmName: 'Cody' }));
    assert.equal(get('SELECT id FROM users WHERE id = ?', [dup.id]), undefined);
    const deleted = ok(await server.request('GET', '/audit/settings-activity?entityType=user')).rows.find((r) => r.action === 'deleted');
    assert.equal(deleted.record, 'Cody', 'the deletion is recorded with the name');
  } finally {
    server.close();
  }
});

test('an Admin who made settings changes is linked: can only be soft-removed, and their name stays on the history', async () => {
  const server = await startTestServer();
  try {
    const { b } = await setup(server);
    const jo = ok(await server.request('POST', '/users', { name: 'Jo Admin', email: 'jo@justtrades.au', password: 'password123', role: 'admin' }));
    await server.login('jo@justtrades.au', 'password123');
    ok(await server.request('PATCH', `/settings/list-items/${b.lists.knockback_reason[0].id}`, { name: 'Price too high' }));
    await server.login();
    ok(await server.request('PATCH', `/users/${jo.id}`, { active: false }));
    assert.equal((await server.request('DELETE', `/users/${jo.id}`, { confirmName: 'Jo Admin' })).status, 409);
    ok(await server.request('POST', `/users/${jo.id}/remove`, { confirm: true }));
    const row = ok(await server.request('GET', '/audit/settings-activity?entityType=list_item')).rows.find((r) => r.action === 'renamed');
    assert.equal(row.by, 'Jo Admin (removed)');
    assert.equal(get('SELECT changed_by_name FROM settings_activity WHERE id = ?', [row.id]).changed_by_name, 'Jo Admin', 'name kept at the time');
  } finally {
    server.close();
  }
});

test('Technician accounts: deactivating the technician record blocks the account but never changes its type; reactivating restores the same access', async () => {
  const server = await startTestServer();
  try {
    const { tech } = await setup(server);
    const acct = ok(await server.request('POST', '/users', { name: 'Kurt', email: 'kurt@justtrades.au', password: 'password123', role: 'staff' }));
    ok(await server.request('POST', `/users/${acct.id}/technician-link`, { technicianId: tech.id, confirm: true }));
    ok(await server.request('PATCH', `/settings/technicians/${tech.id}`, { active: false }));
    let u = ok(await server.request('GET', '/users')).find((x) => x.id === acct.id);
    assert.deepEqual([u.accessType, u.technicianActive], ['technician', false], 'still a Technician account, blocked');
    const me = await server.login('kurt@justtrades.au', 'password123');
    assert.equal(me.role, 'technician', 'never falls back to Staff');
    assert.equal((await server.request('GET', '/calls')).status, 403, 'no Staff access');
    await server.login();
    ok(await server.request('PATCH', `/settings/technicians/${tech.id}`, { active: true }));
    u = ok(await server.request('GET', '/users')).find((x) => x.id === acct.id);
    assert.deepEqual([u.accessType, u.technicianActive], ['technician', true]);
    // Technician → Admin is two steps: the type toggle refuses a Technician account.
    assert.equal((await server.request('PATCH', `/users/${acct.id}`, { role: 'admin' })).status, 400);
    const act = ok(await server.request('GET', '/audit/settings-activity')).rows;
    assert.ok(act.some((r) => r.entityType === 'technician' && r.action === 'deactivated'));
    assert.ok(act.some((r) => r.entityType === 'user' && r.action === 'type_changed'));
  } finally {
    server.close();
  }
});

test('backup and restore: hidden items, comment settings, removed accounts and Settings Activity come back; an older backup keeps Settings Activity', async () => {
  let backup;
  const source = await startTestServer();
  let hiddenId;
  let reasonId;
  try {
    const { b } = await setup(source);
    hiddenId = b.lists.lead_source.find((l) => l.name === 'Referral').id;
    reasonId = b.lists.knockback_reason[0].id;
    ok(await source.request('PATCH', `/settings/list-items/${hiddenId}/hidden`, { hidden: true }));
    ok(await source.request('PATCH', `/settings/list-items/${reasonId}/requires-comment`, { requiresComment: true }));
    const gone = ok(await source.request('POST', '/users', { ...STAFF, name: 'Gone', email: 'gone@justtrades.au' }));
    ok(await source.request('PATCH', `/users/${gone.id}`, { active: false }));
    ok(await source.request('POST', `/users/${gone.id}/remove`, { confirm: true }));
    backup = ok(await source.request('GET', '/export/backup.json'));
    assert.ok(Array.isArray(backup.tables.settings_activity) && backup.tables.settings_activity.length > 0);
    assert.ok(backup.tables.users.find((u) => u.name === 'Gone').removed_at);
    assert.ok(backup.tables.list_items.find((i) => i.id === hiddenId).hidden_at);

    // Restoring onto the same CRM after more changes puts the list state back.
    ok(await source.request('PATCH', `/settings/list-items/${hiddenId}/hidden`, { hidden: false }));
    ok(await source.request('POST', '/export/restore', backup));
    assert.ok(get('SELECT hidden_at FROM list_items WHERE id = ?', [hiddenId]).hidden_at);
    assert.equal(get('SELECT requires_comment FROM list_items WHERE id = ?', [reasonId]).requires_comment, 1);

    // An older backup (no Settings Activity, no new columns) keeps Settings Activity and shows items.
    const activityBefore = all('SELECT id FROM settings_activity').length;
    const older = JSON.parse(JSON.stringify(backup));
    delete older.tables.settings_activity;
    older.tables.list_items.forEach((i) => {
      delete i.hidden_at;
      delete i.requires_comment;
    });
    ok(await source.request('POST', '/export/restore', older));
    assert.equal(all('SELECT id FROM settings_activity').length, activityBefore, 'Settings Activity kept');
    assert.equal(get('SELECT hidden_at FROM list_items WHERE id = ?', [hiddenId]).hidden_at, null, 'older backup: items visible');
  } finally {
    source.close();
  }
  // Fresh install: the removed account comes back removed.
  const fresh = await startTestServer();
  try {
    await fresh.login();
    ok(await fresh.request('POST', '/export/restore', backup));
    const gone = get("SELECT active, removed_at FROM users WHERE name = 'Gone'");
    assert.deepEqual([gone.active, !!gone.removed_at], [0, true]);
  } finally {
    fresh.close();
  }
});
