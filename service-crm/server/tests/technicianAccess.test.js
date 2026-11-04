import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll, get as dbGet, run as dbRun } from '../src/db/index.js';

// Technician accounts (technician_accounts + middleware/auth.js's gate +
// routes/me.js): an existing Staff account deliberately changed by an admin
// to Technician access, linked to one active technician record. Deny by
// default; own data only; view-only; never falls back to Staff access.

const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};
const PRESERVED = ['users', 'calls', 'jobs', 'sales', 'call_backs', 'pending_cancellations', 'reviews', 'review_technicians', 'audit_log', 'follow_ups', 'technicians', 'list_items', 'trades', 'job_types'];
const snapshot = () => Object.fromEntries(PRESERVED.map((t) => [t, dbAll(`SELECT * FROM ${t} ORDER BY rowid`)]));
const sessionsFor = (userId) => dbGet('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', [userId]).n;

async function seed(server) {
  const admin = await server.login();
  const b = ok(await server.request('GET', '/settings/bundle'));
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const electrical = b.trades.find((t) => t.name === 'Electrical');
  const reason = b.lists.knockback_reason[0].id;
  const ryan = ok(await server.request('POST', '/settings/technicians', { name: 'Ryan Tech' }));
  const cody = ok(await server.request('POST', '/settings/technicians', { name: 'Cody Tech' }));
  const sam = ok(await server.request('POST', '/users', { name: 'Sam Staff', email: 'sam@test.local', password: 'password123', role: 'staff' }));
  const kim = ok(await server.request('POST', '/users', { name: 'Kim Staff', email: 'kim@test.local', password: 'password123', role: 'staff' }));
  const job = async (over) =>
    ok(await server.request('POST', '/tech/new-job', { visitDate: '2026-05-10', tradeId: plumbing.id, jobTypeId: plumbing.jobTypes[0].id, lead: 'Qualified', ...over }));
  const made = (jn, techId, value, over = {}) =>
    job({ kind: 'new_job_sale_made', jobNumber: jn, technicianId: techId, invoiceNumber: `INV-${jn}`, invoiceDate: '2026-05-10', saleValueExGst: value, ...over });
  const kb = (jn, techId, over = {}) => job({ kind: 'new_job_no_sale', jobNumber: jn, technicianId: techId, knockbackReasonId: reason, ...over });
  await (made('T-1', ryan.id, 1000));
  await (made('T-2', ryan.id, 600, { tradeId: electrical.id, jobTypeId: electrical.jobTypes[0].id }));
  await (kb('T-3', ryan.id));
  await (kb('T-4', ryan.id));
  ok(await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'T-3', newJobNumber: 'AF-T3', dateLogged: '2026-05-12', creditedTechnicianId: ryan.id, invoiceNumber: 'INV-T3', invoiceDate: '2026-05-12', saleValueExGst: 900 }));
  await (made('C-1', cody.id, 5000));
  await (kb('C-2', cody.id));
  ok(await server.request('POST', '/tech/existing-job-upsell', { jobNumber: 'C-1', invoiceNumber: 'INV-C-1', dateLogged: '2026-05-13', creditedTechnicianId: ryan.id, invoiceDate: '2026-05-13', saleValueExGst: 150 }));
  ok(await server.request('POST', '/tech/call-backs', { jobNumber: 'T-1', visitDate: '2026-05-14', technicianId: ryan.id, creditedTechnicianId: ryan.id, callBackReasonId: b.lists.callback_reason[0].id }));
  ok(await server.request('POST', '/tech/call-backs', { jobNumber: 'C-1', visitDate: '2026-05-14', technicianId: cody.id, creditedTechnicianId: cody.id, callBackReasonId: b.lists.callback_reason[0].id }));
  const review = async (rating, ids, notes) => ok(await server.request('POST', '/reviews', { reviewDate: '2026-05-20', rating, technicianIds: ids, notes }));
  const rOwn = await (review(5, [ryan.id], 'Ryan was great'));
  const rShared = await (review(4, [ryan.id, cody.id], 'Both lovely'));
  const rOther = await (review(2, [cody.id], 'Cody was late'));
  return { admin, ryan, cody, sam, kim, plumbing, electrical, rOwn, rShared, rOther };
}

async function signInAs(server, email) {
  server.setCookie('');
  return server.login(email, 'password123');
}

async function link(server, user, tech) {
  return server.request('POST', `/users/${user.id}/technician-link`, { technicianId: tech.id, confirm: true });
}

// Every route the app registers, with sample values for its parameters.
function allRoutes(app) {
  const SAMPLE = { id: '1', kind: 'new_job_no_sale', filename: 'x.json', category: 'lead_source', reportKey: 'tech' };
  const out = [];
  for (const layer of app._router.stack) {
    if (layer.name !== 'router' || !layer.handle?.stack) continue;
    const mount = layer.regexp.source.replace('^', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
    for (const l of layer.handle.stack) {
      if (!l.route) continue;
      const routePath = l.route.path.replace(/:(\w+)/g, (_, k) => SAMPLE[k] || '1');
      Object.keys(l.route.methods).forEach((m) => out.push({ method: m.toUpperCase(), path: `${mount}${routePath === '/' ? '' : routePath}` }));
    }
  }
  return out;
}
const TECH_ALLOWED = (method, path) =>
  (method === 'POST' && /^\/api\/auth\/(login|logout|change-password)$/.test(path)) ||
  (method === 'GET' && /^\/api\/auth\/me$/.test(path)) ||
  (method === 'GET' && /^\/api\/me(\/.*)?$/.test(path)) ||
  (method === 'GET' && path === '/api/reports/layouts') ||
  (method === 'PUT' && /^\/api\/reports\/layouts\/[^/]+$/.test(path));

test('converting Staff -> Technician changes no stored record or credential, and signs the account out', async () => {
  const server = await startTestServer();
  try {
    const { sam, ryan } = await seed(server);
    const samCookie = (await signInAs(server, 'sam@test.local'), server.getCookie());
    assert.ok(sessionsFor(sam.id) >= 1);
    await server.login();
    const preview = ok(await server.request('GET', `/users/${sam.id}/technician-preview?technicianId=${ryan.id}`));
    assert.deepEqual(preview.blockers, []);
    assert.deepEqual(preview.counts, { jobs: 4, sales: 4, reviews: 2 });
    const before = snapshot();
    assert.equal((await server.request('POST', `/users/${sam.id}/technician-link`, { technicianId: ryan.id })).status, 400, 'requires confirmation');
    const linked = ok(await link(server, sam, ryan));
    assert.equal(linked.accessType, 'technician');
    assert.equal(linked.technicianName, 'Ryan Tech');
    assert.deepEqual(snapshot(), before, 'users row (id, email, password hash, role), jobs, sales, reviews, history all unchanged');
    assert.equal(sessionsFor(sam.id), 0, 'signed out');
    server.setCookie(samCookie);
    assert.equal((await server.request('GET', '/auth/me')).status, 401, 'the old session no longer works');
    const me = await signInAs(server, 'sam@test.local');
    assert.equal(me.role, 'technician', 'same login and password');
    assert.equal(me.id, sam.id, 'same account id');
    assert.equal(me.technicianName, 'Ryan Tech');
    assert.equal(dbGet('SELECT role FROM users WHERE id = ?', [sam.id]).role, 'staff', 'stored role column untouched');
  } finally {
    server.close();
  }
});

test('every route outside the approved list returns 403 to a Technician account', async () => {
  const server = await startTestServer();
  try {
    const { sam, ryan } = await seed(server);
    ok(await link(server, sam, ryan));
    await signInAs(server, 'sam@test.local');
    const routes = allRoutes(server.app);
    assert.ok(routes.length > 80, `found ${routes.length} routes`);
    const before = snapshot();
    const refused = [];
    for (const r of routes) {
      if (r.path === '/api/auth/logout' || r.path === '/api/auth/login' || r.path === '/api/auth/change-password') continue;
      const res = await server.request(r.method, r.path.replace(/^\/api/, ''), r.method === 'GET' ? undefined : {});
      if (TECH_ALLOWED(r.method, r.path)) assert.notEqual(res.status, 403, `${r.method} ${r.path} should be allowed`);
      else {
        assert.equal(res.status, 403, `${r.method} ${r.path} must be refused`);
        refused.push(`${r.method} ${r.path}`);
      }
    }
    assert.ok(refused.length > 75);
    // Altered URLs, unknown routes, query tricks and trailing slashes are refused too.
    for (const p of ['/calls/', '/reports/tech?technicianId=1', '/reviews?technicianId=1', '/tech/entries/export.xlsx', '/nope', '/ME/performance', '/me/../calls', '/export/backup.json']) {
      assert.equal((await server.request('GET', p)).status, 403, `GET ${p}`);
    }
    assert.deepEqual(snapshot(), before, 'no request changed anything');
  } finally {
    server.close();
  }
});

// The statistics a Technician account receives must equal the Admin/Staff
// report exactly — just without anything record-level.
const METRICS = ['jobsAttended', 'qualifiedJobs', 'unqualifiedJobs', 'knockbacks', 'knockbackRate', 'convertedLaterCount', 'conversionRate', 'sales', 'totalSaleExGst', 'avgSaleExGst', 'upsellsCount', 'upsellValueExGst', 'callBacks', 'pendingCancellations', 'inspectionRate', 'optionRate', 'actualKnockbacks', 'convertedLaterCredits', 'adjustedKnockbacks', 'bonusConversionRate'];
const pickF = (o, f) => Object.fromEntries(f.filter((k) => k in o).map((k) => [k, o[k]]));
function statsOf(r) {
  return {
    company: pickF(r.company, METRICS),
    byTrade: r.byTrade.map((x) => pickF(x, ['trade', ...METRICS])),
    byTechnician: r.byTechnician.map((x) => pickF(x, ['name', ...METRICS, 'positiveReviewsCount'])),
    salesByTradePie: r.salesByTradePie,
    jobsOppSalesByTrade: r.jobsOppSalesByTrade,
    trend: r.trend,
    missingTechnicianCount: r.missingTechnicianCount,
    revenueBySuburb: r.revenueBySuburb,
    salesByMarketingCategory: r.salesByMarketingCategory,
  };
}

test('the team report shows the same statistics as the Admin/Staff report — every technician — and nothing record-level', async () => {
  const server = await startTestServer();
  try {
    const { sam, ryan, cody, plumbing } = await seed(server);
    ok(await link(server, sam, ryan));
    const range = 'from=2026-05-01&to=2026-05-31';
    const combos = ['', `&technicianId=${cody.id}`, `&tradeId=${plumbing.id}`, '&saleMade=Yes&leadQualification=Qualified', '&entryType=new_job_no_sale', '&granularity=month'];
    const admin = {};
    for (const c of combos) admin[c] = statsOf(ok(await server.request('GET', `/reports/tech?${range}${c}`)));
    const adminKbr = ok(await server.request('GET', `/reports/tech/knockback-reasons?${range}`));
    const adminKbrCody = ok(await server.request('GET', `/reports/tech/knockback-reasons?${range}&technicianId=${cody.id}`));
    await signInAs(server, 'sam@test.local');
    for (const c of combos) {
      const team = ok(await server.request('GET', `/me/team-report?${range}${c}`));
      assert.deepEqual(statsOf(team), admin[c], `same statistics with filters "${c}"`);
    }
    const plain = ok(await server.request('GET', `/me/team-report?${range}`));
    assert.deepEqual(plain.byTechnician.map((r) => r.name).sort(), ['Cody Tech', 'Ryan Tech'], 'every technician row is shown');
    assert.equal(plain.byTechnician.find((r) => r.name === 'Cody Tech').totalSaleExGst, 5000, "other technicians' values are visible as statistics");
    // Record-identifying filters are ignored, so they can't single out a job.
    for (const c of ['&jobNumber=C-1', '&suburb=Woodcroft', `&createdByUserId=1`, '&lastEditedByUserId=1', '&scopeTechnician=Cody%20Tech']) {
      assert.deepEqual(statsOf(ok(await server.request('GET', `/me/team-report?${range}${c}`))), admin[''], `"${c}" is ignored`);
    }
    const text = JSON.stringify(plain);
    for (const leak of ['T-1', 'C-1', 'INV-', 'records', 'comments', 'createdBy', 'lastEdited', 'job_number', 'jobNumber', 'password', 'email']) {
      assert.ok(!text.includes(leak), `no "${leak}" in the technician report response`);
    }
    // Team Knockback Reasons: counts only, never the job records.
    const kbr = ok(await server.request('GET', `/me/team-knockback-reasons?${range}`));
    assert.deepEqual(kbr, { total: adminKbr.total, byReason: adminKbr.byReason });
    assert.ok(adminKbr.records.length > 0 && !('records' in kbr), 'the admin response has records; the technician one never does');
    assert.deepEqual(ok(await server.request('GET', `/me/team-knockback-reasons?${range}&technicianId=${cody.id}`)), { total: adminKbrCody.total, byReason: adminKbrCody.byReason });
    // Filter names only — no staff accounts.
    const settings = ok(await server.request('GET', '/me/report-settings'));
    assert.deepEqual(Object.keys(settings).sort(), ['lists', 'ownTechnicianId', 'ownTechnicianName', 'technicians', 'trades']);
    assert.equal(settings.ownTechnicianName, 'Ryan Tech');
    assert.ok(!JSON.stringify(settings).includes('@'), 'no account emails');
  } finally {
    server.close();
  }
});

test("only the technician's own figures open records — their own, under the report's filters; other technicians' never", async () => {
  const server = await startTestServer();
  try {
    const { sam, ryan, cody, plumbing } = await seed(server);
    ok(await link(server, sam, ryan));
    const range = 'from=2026-05-01&to=2026-05-31';
    const fields = ['jobsAttended', 'qualifiedJobs', 'sales', 'convertedLaterCredits', 'actualKnockbacks', 'totalSaleExGst', 'avgSaleExGst', 'callBacks', 'pendingCancellations', 'inspectionRate', 'optionRate'];
    const adminDrill = async (field, extra = '') =>
      ok(await server.request('GET', `/reports/tech/drilldown?${range}&metric=${field}&scopeTechnician=Ryan%20Tech${extra}`)).rows.map((r) => `${r.kind}:${r.id}`).sort();
    const expected = {};
    for (const f of fields) expected[f] = await adminDrill(f);
    const expectedPlumbing = await adminDrill('jobsAttended', `&tradeId=${plumbing.id}`);
    await signInAs(server, 'sam@test.local');
    for (const f of fields) {
      // Tampered: another technician's id and name, and record-identifying filters.
      const d = ok(await server.request('GET', `/me/performance/drilldown?${range}&field=${f}&scopeTechnician=Cody%20Tech&technicianId=${cody.id}&jobNumber=C-1`));
      assert.deepEqual(d.rows.map((r) => `${r.kind}:${r.id}`).sort(), expected[f], `${f}: always and only Ryan's own records`);
      for (const r of d.rows) {
        for (const hidden of ['createdByName', 'lastEditedByName', 'historyCount', 'canDelete', 'comments', 'suburb', 'archived']) {
          assert.ok(!(hidden in r), `${f}: no ${hidden}`);
        }
        assert.notEqual(r.technicianName, 'Cody Tech');
      }
    }
    const withTrade = ok(await server.request('GET', `/me/performance/drilldown?${range}&field=jobsAttended&tradeId=${plumbing.id}`));
    assert.deepEqual(withTrade.rows.map((r) => `${r.kind}:${r.id}`).sort(), expectedPlumbing, "the report's filters apply to the own records too");
    const value = ok(await server.request('GET', `/me/performance/drilldown?${range}&field=totalSaleExGst`));
    assert.ok(value.rows.some((r) => r.saleValueExGst === 900), 'their own sale values are shown');
    for (const f of ['unqualifiedJobs', 'missingTechnician', 'revenueBySuburb', 'salesByMarketingCategory', 'salesByTradePie', 'jobsOppSalesByTrade', 'knockbackByReason', 'upsellValueExGst', '']) {
      assert.equal((await server.request('GET', `/me/performance/drilldown?field=${f}&category=Plumbing`)).status, 400, `"${f}" never opens records`);
    }
    // The unrestricted record drill-downs stay closed whatever is asked.
    for (const p of [`/reports/tech/drilldown?metric=sales&scopeTechnician=Cody%20Tech`, '/reports/tech/drilldown?metric=revenueBySuburb&category=Unassigned', '/reports/tech/knockback-reasons', '/reports/reviews/drilldown?metric=total', '/tech/entries']) {
      assert.equal((await server.request('GET', p)).status, 403, p);
    }
  } finally {
    server.close();
  }
});

test('My Reviews: only reviews credited to them, shared ones labelled without other names, strictly view-only', async () => {
  const server = await startTestServer();
  try {
    const { sam, ryan, cody, rOwn, rShared, rOther } = await seed(server);
    ok(await link(server, sam, ryan));
    await signInAs(server, 'sam@test.local');
    const mine = ok(await server.request('GET', `/me/reviews?technicianId=${cody.id}`));
    assert.deepEqual(mine.rows.map((r) => r.id).sort(), [rOwn.id, rShared.id].sort(), 'never the review credited only to Cody');
    assert.equal(mine.rows.find((r) => r.id === rShared.id).shared, true);
    assert.equal(mine.rows.find((r) => r.id === rOwn.id).shared, false);
    assert.deepEqual(Object.keys(mine.rows[0]).sort(), ['classification', 'id', 'notes', 'rating', 'reviewDate', 'shared']);
    assert.ok(!JSON.stringify(mine).includes('Cody'), "no other technician's name or review");
    assert.deepEqual(mine.totals, { total: 2, positive: 2, neutral: 0, negative: 0, averageRating: 4.5, byStars: [{ stars: 5, count: 1 }, { stars: 4, count: 1 }, { stars: 3, count: 0 }, { stars: 2, count: 0 }, { stars: 1, count: 0 }] });
    const before = snapshot();
    assert.equal((await server.request('POST', '/reviews', { reviewDate: '2026-05-21', rating: 5, technicianIds: [ryan.id] })).status, 403, 'add');
    assert.equal((await server.request('PATCH', `/reviews/${rOther.id}`, { technicianIds: [ryan.id] })).status, 403, 'reassign');
    assert.equal((await server.request('PATCH', `/reviews/${rOwn.id}`, { rating: 1 })).status, 403, 'edit own');
    assert.equal((await server.request('GET', '/reviews')).status, 403, 'list all');
    assert.equal((await server.request('GET', '/reports/reviews.xlsx')).status, 403, 'export');
    assert.equal((await server.request('GET', '/reports/reviews')).status, 403, 'company review report');
    assert.deepEqual(snapshot(), before);
    // The shared review still counts for Cody in the admin report.
    await server.login();
    const report = ok(await server.request('GET', '/reports/reviews'));
    assert.equal(report.kpis.total, 3);
  } finally {
    server.close();
  }
});

test('an inactive or missing linked technician blocks the account and never falls back to Staff access', async () => {
  const server = await startTestServer();
  try {
    const { sam, kim, ryan } = await seed(server);
    ok(await link(server, sam, ryan));
    ok(await server.request('PATCH', `/settings/technicians/${ryan.id}`, { active: false }));
    await signInAs(server, 'sam@test.local');
    const me = ok(await server.request('GET', '/auth/me'));
    assert.equal(me.user.role, 'technician');
    assert.equal(me.user.technicianActive, false);
    for (const p of ['/me/team-report', '/me/team-knockback-reasons', '/me/report-settings', '/me/reviews', '/me/performance/drilldown?field=sales']) {
      const res = await server.request('GET', p);
      assert.equal(res.status, 403, p);
      assert.equal(res.data.inactiveTechnician, true);
    }
    for (const p of ['/calls', '/tech/entries', '/reports/tech', '/reviews']) assert.equal((await server.request('GET', p)).status, 403, `${p} — no Staff fallback`);

    // Missing technician record (e.g. a data restore that no longer has it —
    // deletion through the app is refused while linked): same block.
    await server.login();
    const temp = ok(await server.request('POST', '/settings/technicians', { name: 'Temp Tech' }));
    ok(await link(server, kim, temp));
    dbRun('DELETE FROM technicians WHERE id = ?', [temp.id]);
    await signInAs(server, 'kim@test.local');
    assert.equal((await server.request('GET', '/me/team-report')).status, 403);
    assert.equal((await server.request('GET', '/calls')).status, 403);
  } finally {
    server.close();
  }
});

test('one active link per account and per technician; admins and inactive technicians cannot be linked', async () => {
  const server = await startTestServer();
  try {
    const { admin, sam, kim, ryan, cody } = await seed(server);
    ok(await link(server, sam, ryan));
    const dup = await link(server, kim, ryan);
    assert.equal(dup.status, 400);
    assert.match(dup.data.error, /already linked to Sam Staff/);
    assert.match((await link(server, sam, cody)).data.error, /already a Technician account/);
    assert.match((await link(server, admin, cody)).data.error, /Administrator accounts/);
    ok(await server.request('PATCH', `/settings/technicians/${cody.id}`, { active: false }));
    assert.match((await link(server, kim, cody)).data.error, /inactive/);
    assert.throws(() => dbRun('INSERT INTO technician_accounts (user_id, technician_id) VALUES (?, ?)', [kim.id, ryan.id]), /UNIQUE/, 'the database itself refuses a second active link');
    const roleChange = await server.request('PATCH', `/users/${sam.id}`, { role: 'admin' });
    assert.equal(roleChange.status, 400, "a Technician account can't be made an admin directly");
    // Staff and admin accounts can't use the technician routes.
    assert.equal((await server.request('GET', '/me/team-report')).status, 403);
    await signInAs(server, 'kim@test.local');
    assert.equal((await server.request('GET', '/me/reviews')).status, 403);
  } finally {
    server.close();
  }
});

test('changing back to Staff needs confirmation, signs out, restores Staff access and keeps the who/when record', async () => {
  const server = await startTestServer();
  try {
    const { sam, ryan } = await seed(server);
    ok(await link(server, sam, ryan));
    await signInAs(server, 'sam@test.local');
    assert.equal((await server.request('GET', '/calls')).status, 403);
    await server.login();
    const before = snapshot();
    assert.equal((await server.request('POST', `/users/${sam.id}/technician-unlink`, {})).status, 400, 'requires confirmation');
    await signInAs(server, 'sam@test.local');
    await server.login();
    const back = ok(await server.request('POST', `/users/${sam.id}/technician-unlink`, { confirm: true }));
    assert.equal(back.accessType, 'staff');
    assert.equal(sessionsFor(sam.id), 0);
    assert.deepEqual(snapshot(), before, 'no stored record changed');
    const rows = dbAll('SELECT * FROM technician_accounts WHERE user_id = ?', [sam.id]);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].linked_at && rows[0].unlinked_at && rows[0].linked_by_user_id && rows[0].unlinked_by_user_id, 'who/when kept');
    const me = await signInAs(server, 'sam@test.local');
    assert.equal(me.role, 'staff');
    assert.equal((await server.request('GET', '/calls')).status, 200, 'Staff access restored');
    assert.equal((await server.request('GET', '/me/team-report')).status, 403);
    // The technician can be linked again afterwards.
    await server.login();
    ok(await link(server, sam, ryan));
  } finally {
    server.close();
  }
});

test('a technician linked to an active Technician account cannot be deleted; deactivation and unlinking work as designed', async () => {
  const server = await startTestServer();
  try {
    const { sam, kim } = await seed(server);
    const spare = ok(await server.request('POST', '/settings/technicians', { name: 'Spare Tech' })); // no jobs, so deletable by the other rules
    ok(await link(server, sam, spare));
    const before = dbAll('SELECT * FROM technicians ORDER BY id');

    const refused = await server.request('DELETE', `/settings/technicians/${spare.id}`);
    assert.equal(refused.status, 409);
    assert.equal(
      refused.data.error,
      'This technician is linked to a Technician account. Change that account back to Staff, link it to another technician, or deactivate the account before deleting this technician.'
    );
    assert.deepEqual(dbAll('SELECT * FROM technicians ORDER BY id'), before, 'no part of the technician record was deleted');
    await signInAs(server, 'sam@test.local');
    assert.equal((await server.request('GET', '/me/team-report')).status, 200, 'the linked account is still a working Technician account');
    assert.equal((await server.request('GET', '/calls')).status, 403, '...and still restricted');

    // Deactivating the technician still works and blocks the account at once.
    await server.login();
    ok(await server.request('PATCH', `/settings/technicians/${spare.id}`, { active: false }));
    await signInAs(server, 'sam@test.local');
    assert.equal((await server.request('GET', '/me/team-report')).status, 403);
    assert.equal((await server.request('GET', '/calls')).status, 403, 'blocked, never Staff');

    // Back to Staff closes the link; deletion is then decided by the normal rules.
    await server.login();
    ok(await server.request('POST', `/users/${sam.id}/technician-unlink`, { confirm: true }));
    assert.equal(dbGet('SELECT COUNT(*) AS n FROM technician_accounts WHERE technician_id = ? AND unlinked_at IS NULL', [spare.id]).n, 0);
    ok(await server.request('DELETE', `/settings/technicians/${spare.id}`));
    assert.equal(dbGet('SELECT id FROM technicians WHERE id = ?', [spare.id]), undefined);
    const history = dbAll('SELECT * FROM technician_accounts WHERE technician_id = ?', [spare.id]);
    assert.equal(history.length, 1, 'the historical link row is kept');
    assert.ok(history[0].linked_at && history[0].linked_by_user_id && history[0].unlinked_at && history[0].unlinked_by_user_id);

    // A technician with records is still refused by the existing rule after unlinking.
    const ryan = dbGet("SELECT id FROM technicians WHERE name = 'Ryan Tech'");
    ok(await link(server, kim, ryan));
    assert.equal((await server.request('DELETE', `/settings/technicians/${ryan.id}`)).status, 409, 'refused while linked');
    ok(await server.request('POST', `/users/${kim.id}/technician-unlink`, { confirm: true }));
    const afterUnlink = await server.request('DELETE', `/settings/technicians/${ryan.id}`);
    assert.equal(afterUnlink.status, 409);
    assert.match(afterUnlink.data.error, /linked records/, 'the existing linked-records rule still applies');

    // Deactivating the ACCOUNT also allows deletion (the message names it as an option).
    const other = ok(await server.request('POST', '/settings/technicians', { name: 'Other Tech' }));
    ok(await link(server, kim, other));
    ok(await server.request('PATCH', `/users/${kim.id}`, { active: false }));
    ok(await server.request('DELETE', `/settings/technicians/${other.id}`));
  } finally {
    server.close();
  }
});
