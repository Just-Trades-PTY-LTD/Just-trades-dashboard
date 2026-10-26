import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// A brand-new job's Trade/Job Type can be auto-filled from the matching
// Calls & Contacts record's own Trade/Job Type (staff already select these
// when logging the call) — exactly the same convention already used for
// Suburb (see jobSuburb.test.js), but an exact foreign-key reference rather
// than a free-text match. See routes/lookup.js's GET /call and
// LogEntry.jsx's callLookup auto-fill effect.

async function setup(server) {
  await server.login();
  const bundle = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = bundle.trades.find((t) => t.name === 'Plumbing');
  const electrical = bundle.trades.find((t) => t.name === 'Electrical');
  return { plumbing, plumbingJobTypeId: plumbing.jobTypes[0].id, electrical, electricalJobTypeId: electrical.jobTypes[0].id };
}

async function logCall(server, { jobNumber, tradeId, jobTypeId, callAt = '2026-06-01T09:00' }) {
  const res = await server.request('POST', '/calls', {
    callAt,
    direction: 'Inbound',
    callType: 'Lead',
    booked: 'Yes',
    jobNumber,
    tradeId,
    jobTypeId,
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data;
}

test('/lookup/call returns the matching call\'s Trade and Job Type alongside Suburb', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, plumbingJobTypeId } = await setup(server);
    await logCall(server, { jobNumber: 'JN-CTJ-1', tradeId: plumbing.id, jobTypeId: plumbingJobTypeId });

    const lookup = await server.request('GET', '/lookup/call?jn=JN-CTJ-1');
    assert.equal(lookup.data.found, true);
    assert.equal(lookup.data.tradeId, plumbing.id);
    assert.equal(lookup.data.jobTypeId, plumbingJobTypeId);
  } finally {
    server.close();
  }
});

test('A call logged with no Trade/Job Type recorded leaves both null, never a guess', async () => {
  const server = await startTestServer();
  try {
    await setup(server);
    const res = await server.request('POST', '/calls', {
      callAt: '2026-06-01T09:00',
      direction: 'Inbound',
      callType: 'Lead',
      booked: 'Yes',
      jobNumber: 'JN-CTJ-BLANK',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));

    const lookup = await server.request('GET', '/lookup/call?jn=JN-CTJ-BLANK');
    assert.equal(lookup.data.found, true);
    assert.equal(lookup.data.tradeId, null);
    assert.equal(lookup.data.jobTypeId, null);
  } finally {
    server.close();
  }
});

test('Multiple calls share the same Job Number: the earliest (original booking) call\'s Trade/Job Type is used, never a later one\'s', async () => {
  const server = await startTestServer();
  try {
    const { plumbing, plumbingJobTypeId, electrical, electricalJobTypeId } = await setup(server);
    await logCall(server, { jobNumber: 'JN-CTJ-MULTI', tradeId: electrical.id, jobTypeId: electricalJobTypeId, callAt: '2026-06-05T09:00' });
    await logCall(server, { jobNumber: 'JN-CTJ-MULTI', tradeId: plumbing.id, jobTypeId: plumbingJobTypeId, callAt: '2026-06-01T09:00' });

    const lookup = await server.request('GET', '/lookup/call?jn=JN-CTJ-MULTI');
    assert.equal(lookup.data.tradeId, plumbing.id, 'the earliest call by call_at, not insertion order or a later one');
    assert.equal(lookup.data.jobTypeId, plumbingJobTypeId);
  } finally {
    server.close();
  }
});
