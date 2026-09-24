import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

async function setup(server) {
  await server.login();
  const tech = (await server.request('POST', '/settings/technicians', { name: 'Mandatory Tech' })).data;
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  return { tech, bundle, plumbing };
}

function validNewJobBody(tech, plumbing, overrides = {}) {
  return {
    kind: 'new_job_no_sale',
    visitDate: '2026-10-01',
    technicianId: tech.id,
    jobNumber: 'JN-MAND-1',
    tradeId: plumbing.id,
    jobTypeId: plumbing.jobTypes[0].id,
    lead: 'Qualified',
    knockbackReasonId: null,
    ...overrides,
  };
}

test('New Job creation is rejected when Visit Date, Technician, Job Number, Trade, Job Type or Lead is missing, naming every missing field at once', async () => {
  const server = await startTestServer();
  try {
    const { tech, bundle, plumbing } = await setup(server);
    const knockbackReasonId = bundle.lists.knockback_reason[0].id;

    const res = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      // visitDate, technicianId, jobNumber, tradeId, jobTypeId and lead all omitted.
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /Visit Date/);
    assert.match(res.data.error, /Technician/);
    assert.match(res.data.error, /Job Number/);
    assert.match(res.data.error, /Trade/);
    assert.match(res.data.error, /Job Type/);
    assert.match(res.data.error, /Lead status/);

    // Filling in every field but one still names only that one.
    const missingJobTypeOnly = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale',
      visitDate: '2026-10-01',
      technicianId: tech.id,
      jobNumber: 'JN-MAND-JT',
      tradeId: plumbing.id,
      lead: 'Qualified',
      knockbackReasonId,
    });
    assert.equal(missingJobTypeOnly.status, 400);
    assert.equal(missingJobTypeOnly.data.error, 'Please complete the following required field before saving: Job Type.');
  } finally {
    server.close();
  }
});

test('editing an existing New Job entry is never blocked by the mandatory-field check, even with fields cleared', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing } = await setup(server);
    const created = await server.request('POST', '/tech/new-job', validNewJobBody(tech, plumbing, { knockbackReasonId: null, lead: 'Not Qualified' }));
    assert.equal(created.status, 201);

    const patched = await server.request('PATCH', `/tech/new-job/${created.data.entry.id}`, {
      technicianId: '',
      tradeId: '',
      jobTypeId: '',
    });
    assert.equal(patched.status, 200, 'editing is never blocked by the same checks creation enforces');
  } finally {
    server.close();
  }
});

test('a brand-new job with a Job Number that already belongs to another active job is rejected, and nothing is created', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing } = await setup(server);
    const first = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-DUPE-1', lead: 'Not Qualified' })
    );
    assert.equal(first.status, 201);

    const dupe = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-DUPE-1', visitDate: '2026-10-05', lead: 'Not Qualified' })
    );
    assert.equal(dupe.status, 400);
    assert.match(dupe.data.error, /JN-DUPE-1 already exists/);
    assert.match(dupe.data.error, /Quote Approved Later|Call Back/);

    const entries = (await server.request('GET', '/tech/entries')).data;
    assert.equal(entries.filter((e) => e.jobNumber === 'JN-DUPE-1').length, 1, 'the duplicate attempt created nothing');
  } finally {
    server.close();
  }
});

test('an archived job with the same Job Number does not block a brand-new job on that JN', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing } = await setup(server);
    const first = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-ARCH-1', lead: 'Not Qualified' })
    );
    await server.request('PATCH', `/tech/entries/new_job_no_sale/${first.data.entry.id}/archive`, { archived: true });

    const second = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-ARCH-1', visitDate: '2026-10-06', lead: 'Not Qualified' })
    );
    assert.equal(second.status, 201, 'an archived job is not "active", so it does not count as a duplicate');
  } finally {
    server.close();
  }
});

test('Reason for Knockback is mandatory only for a No Sale entry with a Qualified lead — never for Unqualified, never for Sale Made', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing } = await setup(server);

    const qualifiedNoReason = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-KB-1', lead: 'Qualified', knockbackReasonId: null })
    );
    assert.equal(qualifiedNoReason.status, 400);
    assert.equal(qualifiedNoReason.data.error, 'Please select a Reason for Knockback before saving.');

    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const priceReasonId = bundle.lists.knockback_reason.find((r) => r.name === 'Price').id;

    const qualifiedWithReason = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-KB-2', lead: 'Qualified', knockbackReasonId: priceReasonId })
    );
    assert.equal(qualifiedWithReason.status, 201);
    assert.equal(qualifiedWithReason.data.entry.knockback, true, 'a Qualified No Sale entry is a genuine knock-back');

    const unqualifiedNoReason = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-KB-3', lead: 'Not Qualified', knockbackReasonId: null })
    );
    assert.equal(unqualifiedNoReason.status, 201, 'an Unqualified lead never requires a Reason for Knockback');
    assert.equal(unqualifiedNoReason.data.entry.knockback, false, 'an Unqualified No Sale entry is never flagged as a knock-back');

    const saleMade = await server.request('POST', '/tech/new-job', {
      kind: 'new_job_sale_made',
      visitDate: '2026-10-01',
      technicianId: tech.id,
      jobNumber: 'JN-KB-4',
      tradeId: plumbing.id,
      jobTypeId: plumbing.jobTypes[0].id,
      lead: 'Qualified',
      invoiceNumber: 'INV-KB-4',
      invoiceDate: '2026-10-01',
      saleValueExGst: 200,
    });
    assert.equal(saleMade.status, 201, 'a Sale Made entry never requires a Reason for Knockback');
    assert.equal(saleMade.data.entry.knockback, false);
  } finally {
    server.close();
  }
});

test('an unqualified no-sale job is never counted as a knock-back to convert, even if a later Quote Approved Later sale references its JN', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing } = await setup(server);
    const job = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-KB-NOFLIP', lead: 'Not Qualified', knockbackReasonId: null })
    );
    assert.equal(job.data.entry.knockback, false);

    const approved = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-KB-NOFLIP',
      dateLogged: '2026-10-10',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-KB-NOFLIP',
      invoiceDate: '2026-10-10',
      saleValueExGst: 250,
    });
    assert.equal(approved.status, 201);

    const entries = (await server.request('GET', '/tech/entries')).data;
    const jobAfter = entries.find((e) => e.jobNumber === 'JN-KB-NOFLIP' && e.kind === 'new_job_no_sale');
    assert.equal(jobAfter.convertedLater, false, 'an unqualified job was never a knock-back, so it can never be "converted"');
  } finally {
    server.close();
  }
});

test('Reason for Knockback "Other" requires a brief Additional Comments explanation; every other reason (including "Unknown/not provided") does not', async () => {
  const server = await startTestServer();
  try {
    const { tech, plumbing } = await setup(server);
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const otherReasonId = bundle.lists.knockback_reason.find((r) => r.name === 'Other').id;
    const unknownReasonId = bundle.lists.knockback_reason.find((r) => r.name === 'Unknown/not provided').id;

    const otherNoComments = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-OTHER-1', lead: 'Qualified', knockbackReasonId: otherReasonId, comments: '' })
    );
    assert.equal(otherNoComments.status, 400);
    assert.match(otherNoComments.data.error, /Additional Comments/);

    const otherWithComments = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, {
        jobNumber: 'JN-OTHER-2',
        lead: 'Qualified',
        knockbackReasonId: otherReasonId,
        comments: 'Customer moved interstate before the job could proceed.',
      })
    );
    assert.equal(otherWithComments.status, 201);

    const unknownNoComments = await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-UNKNOWN-1', lead: 'Qualified', knockbackReasonId: unknownReasonId, comments: '' })
    );
    assert.equal(unknownNoComments.status, 201, '"Unknown/not provided" never requires Additional Comments');
  } finally {
    server.close();
  }
});

test('all requested knockback reasons are available alongside the original ones, with none removed or renamed', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const bundle = (await server.request('GET', '/settings/bundle')).data;
    const names = bundle.lists.knockback_reason.map((r) => r.name);
    for (const original of ['Price', 'Wanted to compare quotes', 'Wants to think it over', 'Not the decision maker', 'Other']) {
      assert.ok(names.includes(original), `original reason "${original}" must still be present`);
    }
    for (const added of [
      'Customer getting other quotes',
      'Customer not ready to proceed',
      'Customer declined',
      'Unable to contact/customer unavailable',
      'Finance/payment issue',
      'Work not required',
      'Competitor selected',
      'Unknown/not provided',
    ]) {
      assert.ok(names.includes(added), `new reason "${added}" must be available`);
    }
    assert.equal(new Set(names).size, names.length, 'no duplicate reasons');
  } finally {
    server.close();
  }
});

test('Existing Job — Quote Approved Later must match an existing Job Number, and is rejected with no match, without creating a sale', async () => {
  const server = await startTestServer();
  try {
    const { tech } = await setup(server);

    const noMatch = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-NO-SUCH-JOB',
      dateLogged: '2026-10-15',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-NOMATCH',
      invoiceDate: '2026-10-15',
      saleValueExGst: 100,
    });
    assert.equal(noMatch.status, 400);
    assert.match(noMatch.data.error, /No existing job found/);

    const noJobNumber = await server.request('POST', '/tech/quote-approved-later', {
      dateLogged: '2026-10-15',
      creditedTechnicianId: tech.id,
    });
    assert.equal(noJobNumber.status, 400);
    assert.match(noJobNumber.data.error, /Job Number/);

    const entries = (await server.request('GET', '/tech/entries')).data;
    assert.equal(entries.filter((e) => e.kind === 'quote_approved_later').length, 0, 'nothing was created for either rejected attempt');
  } finally {
    server.close();
  }
});

test('Existing Job — Quote Approved Later auto-populates Technician, Trade and Job Type from the matched job, and an explicit override in the request wins', async () => {
  const server = await startTestServer();
  try {
    const { tech, bundle, plumbing } = await setup(server);
    const electrical = bundle.trades.find((t) => t.name === 'Electrical');

    await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-QAL-AUTOFILL', lead: 'Not Qualified', knockbackReasonId: null })
    );

    const matched = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-QAL-AUTOFILL',
      dateLogged: '2026-10-16',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-QAL-AUTOFILL',
      invoiceDate: '2026-10-16',
      saleValueExGst: 150,
    });
    assert.equal(matched.status, 201);
    assert.equal(matched.data.entry.tradeId, plumbing.id, 'Trade auto-populated from the matched original job');
    assert.equal(matched.data.entry.jobTypeId, plumbing.jobTypes[0].id, 'Job Type auto-populated from the matched original job');

    const overridden = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-QAL-AUTOFILL',
      dateLogged: '2026-10-17',
      creditedTechnicianId: tech.id,
      tradeId: electrical.id,
      jobTypeId: electrical.jobTypes[0].id,
      invoiceNumber: 'INV-QAL-OVERRIDE',
      invoiceDate: '2026-10-17',
      saleValueExGst: 90,
    });
    assert.equal(overridden.status, 201);
    assert.equal(overridden.data.entry.tradeId, electrical.id, 'an explicit Trade in the request overrides the matched job value');
    assert.equal(overridden.data.entry.jobTypeId, electrical.jobTypes[0].id);
  } finally {
    server.close();
  }
});

test('editing an existing Quote Approved Later sale can change Trade and Job Type, and is never blocked by the Job Number match requirement', async () => {
  const server = await startTestServer();
  try {
    const { tech, bundle, plumbing } = await setup(server);
    const electrical = bundle.trades.find((t) => t.name === 'Electrical');
    await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-QAL-EDIT', lead: 'Not Qualified', knockbackReasonId: null })
    );
    const created = await server.request('POST', '/tech/quote-approved-later', {
      jobNumber: 'JN-QAL-EDIT',
      dateLogged: '2026-10-18',
      creditedTechnicianId: tech.id,
      invoiceNumber: 'INV-QAL-EDIT',
      invoiceDate: '2026-10-18',
      saleValueExGst: 120,
    });

    const patched = await server.request('PATCH', `/tech/quote-approved-later/${created.data.entry.id}`, {
      jobNumber: 'JN-DOES-NOT-EXIST-AT-ALL',
      tradeId: electrical.id,
      jobTypeId: electrical.jobTypes[0].id,
    });
    assert.equal(patched.status, 200, 'editing is never blocked by the "must match" rule that only applies to creation');
    assert.equal(patched.data.tradeId, electrical.id);
    assert.equal(patched.data.jobTypeId, electrical.jobTypes[0].id);
  } finally {
    server.close();
  }
});

test('Call Back and Pending Cancellation require a Job Number, but are never blocked for lack of a matching job', async () => {
  const server = await startTestServer();
  try {
    await setup(server);

    const callBackNoJn = await server.request('POST', '/tech/call-backs', { visitDate: '2026-10-20', comments: 'x' });
    assert.equal(callBackNoJn.status, 400);
    assert.match(callBackNoJn.data.error, /Job Number/);

    const callBackNoMatch = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-NEVER-SEEN-BEFORE',
      visitDate: '2026-10-20',
      comments: 'still allowed',
    });
    assert.equal(callBackNoMatch.status, 201, 'Call Back does not require an existing match, unlike Quote Approved Later');

    const pendingCancelNoJn = await server.request('POST', '/tech/pending-cancellations', { dateLogged: '2026-10-20' });
    assert.equal(pendingCancelNoJn.status, 400);
    assert.match(pendingCancelNoJn.data.error, /Job Number/);
  } finally {
    server.close();
  }
});

test('Call Back auto-populates Trade and Job Type from the matched job, and an explicit override wins; both are editable afterwards', async () => {
  const server = await startTestServer();
  try {
    const { tech, bundle, plumbing } = await setup(server);
    const electrical = bundle.trades.find((t) => t.name === 'Electrical');
    await server.request(
      'POST',
      '/tech/new-job',
      validNewJobBody(tech, plumbing, { jobNumber: 'JN-CB-AUTOFILL', lead: 'Not Qualified', knockbackReasonId: null })
    );

    const callBack = await server.request('POST', '/tech/call-backs', {
      jobNumber: 'JN-CB-AUTOFILL',
      visitDate: '2026-10-21',
      technicianId: tech.id,
      comments: 'return visit',
    });
    assert.equal(callBack.status, 201);
    assert.equal(callBack.data.entry.tradeId, plumbing.id);
    assert.equal(callBack.data.entry.jobTypeId, plumbing.jobTypes[0].id);

    const patched = await server.request('PATCH', `/tech/call-backs/${callBack.data.entry.id}`, {
      tradeId: electrical.id,
      jobTypeId: electrical.jobTypes[0].id,
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.tradeId, electrical.id);
    assert.equal(patched.data.jobTypeId, electrical.jobTypes[0].id);
  } finally {
    server.close();
  }
});
