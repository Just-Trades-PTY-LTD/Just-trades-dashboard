import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('a deactivated technician is excluded from the active-only directory used to assign new work, while remaining fully attached to its existing records', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Departing Tech' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    const job = (
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-12-01',
        technicianId: tech.id,
        jobNumber: 'JN-DEACT-1',
        tradeId: plumbing.id,
        jobTypeId: plumbing.jobTypes[0].id,
        lead: 'Not Qualified',
      })
    ).data.entry;

    const patched = await server.request('PATCH', `/settings/technicians/${tech.id}`, { active: false });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.active, 0);

    const bundleAfter = (await server.request('GET', '/settings/bundle')).data;
    const techAfter = bundleAfter.technicians.find((t) => t.id === tech.id);
    assert.equal(techAfter.active, false, 'bundle reflects the technician as inactive');

    // The existing job is completely untouched by deactivating its technician.
    const entries = (await server.request('GET', '/tech/entries')).data;
    const jobAfter = entries.find((e) => e.id === job.id && e.kind === 'new_job_no_sale');
    assert.equal(jobAfter.technicianId, tech.id, 'still attached to the same technician');
    assert.equal(jobAfter.technicianName, 'Departing Tech', 'still resolves and displays the name correctly');
  } finally {
    server.close();
  }
});

test('an inactive technician cannot be assigned to a brand-new job, call back, or as install technician — but editing an existing record that already has one is never blocked', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Inactive For New Work' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
    await server.request('PATCH', `/settings/technicians/${tech.id}`, { active: false });

    const newJobRes = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-12-02',
      technicianId: tech.id,
      jobNumber: 'JN-DEACT-2',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Not Qualified',
    });
    assert.equal(newJobRes.status, 400);
    assert.match(newJobRes.data.error, /deactivated/);

    const callBackRes = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-DEACT-ANY',
      visitDate: '2026-12-02',
      technicianId: tech.id,
    });
    assert.equal(callBackRes.status, 400);
    assert.match(callBackRes.data.error, /deactivated/);

    const saleMadeRes = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-12-02',
      technicianId: (await server.request('POST', '/settings/technicians', { name: 'Active Attendant' })).data.id,
      jobNumber: 'JN-DEACT-3',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      installTechnicianId: tech.id,
      invoiceNumber: 'INV-DEACT-3',
      invoiceDate: '2026-12-02',
      saleValueExGst: 100,
    });
    assert.equal(saleMadeRes.status, 400);
    assert.match(saleMadeRes.data.error, /install technician.*deactivated/i);

    // Now prove editing an EXISTING record already assigned to this inactive
    // technician is never blocked — create it first while still active.
    await server.request('PATCH', `/settings/technicians/${tech.id}`, { active: true });
    const created = (
      await server.request('POST', '/tech/new-job', {
        kind: 'new_job_no_sale',
        visitDate: '2026-12-03',
        technicianId: tech.id,
        jobNumber: 'JN-DEACT-4',
        tradeId: plumbing.id,
        jobTypeId: plumbing.jobTypes[0].id,
        lead: 'Not Qualified',
      })
    ).data.entry;
    await server.request('PATCH', `/settings/technicians/${tech.id}`, { active: false });

    const editRes = await server.request('PATCH', `/tech/new-job/${created.id}`, { comments: 'still editable' });
    assert.equal(editRes.status, 200, 'editing an existing record already assigned to a now-inactive technician is never blocked');
    assert.equal(editRes.data.technicianId, tech.id, 'the inactive technician stays assigned unless deliberately changed');
  } finally {
    server.close();
  }
});

test('Quote Approved Later can still find and link to a job whose technician was later deactivated, and linking never reactivates them', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const tech = (await server.request('POST', '/settings/technicians', { name: 'Left The Company' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-12-05',
      technicianId: tech.id,
      jobNumber: 'JN-DEACT-QAL',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      knockbackReasonId: bundle.lists.knockback_reason[0].id,
    });
    await server.request('PATCH', `/settings/technicians/${tech.id}`, { active: false });

    const approved = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-DEACT-QAL',
      dateLogged: '2026-12-10',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-DEACT-QAL',
      invoiceDate: '2026-12-10',
      saleValueExGst: 400,
    });
    assert.equal(approved.status, 201, 'Quote Approved Later can still match and credit an inactive technician');
    assert.equal(approved.data.entry.creditedTechnicianId, tech.id);

    const bundleAfter = (await server.request('GET', '/settings/bundle')).data;
    const techAfter = bundleAfter.technicians.find((t) => t.id === tech.id);
    assert.equal(techAfter.active, false, 'linking an old record to a deactivated technician never reactivates them');
  } finally {
    server.close();
  }
});

test('a technician with linked records cannot be permanently deleted (friendly 409, not a raw 500), and the bundle flags canDelete accordingly', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const linkedTech = (await server.request('POST', '/settings/technicians', { name: 'Has Jobs' })).data;
    const freeTech = (await server.request('POST', '/settings/technicians', { name: 'Never Assigned' })).data;
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');

    await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-12-06',
      technicianId: linkedTech.id,
      jobNumber: 'JN-DEACT-DEL',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Not Qualified',
    });

    const bundleAfter = (await server.request('GET', '/settings/bundle')).data;
    assert.equal(bundleAfter.technicians.find((t) => t.id === linkedTech.id).canDelete, false);
    assert.equal(bundleAfter.technicians.find((t) => t.id === freeTech.id).canDelete, true);

    const deleteLinked = await server.request('DELETE', `/settings/technicians/${linkedTech.id}`);
    assert.equal(deleteLinked.status, 409);
    assert.equal(
      deleteLinked.data.error,
      'This technician has linked records and cannot be permanently deleted. Please deactivate them instead.'
    );

    const deleteFree = await server.request('DELETE', `/settings/technicians/${freeTech.id}`);
    assert.equal(deleteFree.status, 200, 'a technician with no linked records can still be permanently deleted');
  } finally {
    server.close();
  }
});

test('a deactivated user account is immediately rejected — new logins and an already-live session both stop working — while its name still resolves on everything it created', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    await server.request('POST', '/users', { name: 'Leaving Staff', email: 'leaving@justtrades.au', password: 'password123', role: 'staff' });

    // Log in as the new staff member in a second "session" (its own cookie),
    // make a call under their name, then switch back to admin.
    await server.login('leaving@justtrades.au', 'password123');
    const staffCookie = server.getCookie();
    const call = await server.request('POST', '/calls', { callAt: '2026-12-07T09:00', direction: 'Inbound', callType: 'Not lead' });
    assert.equal(call.status, 201);

    await server.login(); // back to admin
    const staffUser = (await server.request('GET', '/users')).data.find((u) => u.email === 'leaving@justtrades.au');
    const deactivate = await server.request('PATCH', `/users/${staffUser.id}`, { active: false });
    assert.equal(deactivate.status, 200);
    assert.equal(deactivate.data.active, false);

    // A fresh login attempt is rejected outright.
    const loginAttempt = await server.request('POST', '/auth/login', { email: 'leaving@justtrades.au', password: 'password123' });
    assert.equal(loginAttempt.status, 401);

    // The staff member's OLD, still-technically-live session cookie is also
    // rejected on its very next request — deactivation takes effect immediately.
    server.setCookie(staffCookie);
    const meCheck = await server.request('GET', '/auth/me');
    assert.equal(meCheck.status, 401, "a deactivated account's existing session is rejected immediately, not just at next login");

    // Switch back to admin and confirm the call this person created is
    // completely untouched, with their name still attached.
    await server.login();
    const calls = (await server.request('GET', '/calls?includeArchived=true')).data;
    const theirCall = calls.find((c) => c.id === call.data.id);
    assert.ok(theirCall, 'the call they created still exists, unaltered');
    assert.equal(theirCall.createdByName, 'Leaving Staff', "their name is still attached, even though they're now deactivated");
  } finally {
    server.close();
  }
});

test('reactivating a user restores their login access and returns them to the active-only directory', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    await server.request('POST', '/users', { name: 'Returning Staff', email: 'returning@justtrades.au', password: 'password123', role: 'staff' });
    const staffUser = (await server.request('GET', '/users')).data.find((u) => u.email === 'returning@justtrades.au');

    await server.request('PATCH', `/users/${staffUser.id}`, { active: false });
    let directory = (await server.request('GET', '/users/directory')).data;
    assert.ok(!directory.some((u) => u.id === staffUser.id), 'excluded from the active-only directory while deactivated');

    const directoryAll = (await server.request('GET', '/users/directory?all=1')).data;
    assert.ok(directoryAll.some((u) => u.id === staffUser.id), 'still findable in the "all" directory used for historical filters');

    await server.request('PATCH', `/users/${staffUser.id}`, { active: true });
    directory = (await server.request('GET', '/users/directory')).data;
    assert.ok(directory.some((u) => u.id === staffUser.id), 'reactivated account reappears in the active-only directory');

    const loginAttempt = await server.request('POST', '/auth/login', { email: 'returning@justtrades.au', password: 'password123' });
    assert.equal(loginAttempt.status, 200, 'reactivated account can log in again');
  } finally {
    server.close();
  }
});

test('an administrator cannot deactivate their own account', async () => {
  const server = await startTestServer();
  try {
    const me = await server.login();
    const res = await server.request('PATCH', `/users/${me.id}`, { active: false });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /own account/);
  } finally {
    server.close();
  }
});

// Reaching "last active admin, deactivated by someone else" isn't possible
// through any legitimate login-gated flow: the moment only one admin is
// active, they're the only admin who *can* be logged in to attempt it, which
// makes it a self-deactivation attempt — already independently blocked. The
// two rules together are what guarantee at least one active admin always
// remains; this exercises both sides of that guarantee, including the one
// non-self case that IS reachable (deactivating one of two active admins).
test('deactivating one of two active admins is allowed, and the resulting sole active admin still cannot deactivate themselves — the system can never be left with zero active admins', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const seededAdmin = (await server.request('GET', '/users')).data.find((u) => u.email === 'admin@justtrades.au');
    const secondAdmin = (
      await server.request('POST', '/users', { name: 'Second Admin', email: 'second-admin@justtrades.au', password: 'password123', role: 'admin' })
    ).data;

    const withTwoActive = await server.request('PATCH', `/users/${secondAdmin.id}`, { active: false });
    assert.equal(withTwoActive.status, 200, 'fine to deactivate one admin while another stays active');

    const activeAdmins = (await server.request('GET', '/users')).data.filter((u) => u.role === 'admin' && u.active);
    assert.deepEqual(
      activeAdmins.map((a) => a.id),
      [seededAdmin.id],
      'exactly one active admin remains'
    );

    const selfBlock = await server.request('PATCH', `/users/${seededAdmin.id}`, { active: false });
    assert.equal(selfBlock.status, 400, 'the sole remaining active admin still cannot deactivate themselves');

    // Reactivating the second admin makes deactivating the seeded one safe
    // again, from the second admin's own session.
    await server.request('PATCH', `/users/${secondAdmin.id}`, { active: true, role: 'admin' });
    await server.login('second-admin@justtrades.au', 'password123');
    const nowSafe = await server.request('PATCH', `/users/${seededAdmin.id}`, { active: false });
    assert.equal(nowSafe.status, 200, 'safe once a second active admin exists to act as the one deactivating');
  } finally {
    server.close();
  }
});

test('there is no route to permanently delete a user account, and a direct request against it fails cleanly rather than with a raw 500', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const staff = (await server.request('POST', '/users', { name: 'Someone', email: 'someone@justtrades.au', password: 'password123', role: 'staff' })).data;
    const res = await server.request('DELETE', `/users/${staff.id}`);
    assert.ok(res.status === 404 || res.status === 405, `expected a clean 404/405, got ${res.status}`);
  } finally {
    server.close();
  }
});
