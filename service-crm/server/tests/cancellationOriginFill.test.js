import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';
import { planCancellationFill, cancellationFillConfirmation } from '../../client/src/lib/cancellationFill.js';

// New Job Cancellation: Trade, Job type and Suburb from the Technician &
// Sales job with the same exact Job Number, else its booked Lead call(s).
const ok = (res) => {
  assert.ok(res.status === 200 || res.status === 201, JSON.stringify(res.data));
  return res.data;
};

test('lookup: the job first; else every active booked Lead call with that exact Job Number; nothing else copied; read-only', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const b = ok(await server.request('GET', '/settings/bundle'));
    const el = b.trades.find((t) => t.name === 'Electrical');
    const pl = b.trades.find((t) => t.name === 'Plumbing');
    const tech = ok(await server.request('POST', '/settings/technicians', { name: 'Tech One' }));
    const lead = (over) => server.request('POST', '/calls', { direction: 'Inbound', callType: 'Lead', booked: 'Yes', leadSourceId: b.lists.lead_source[0].id, notes: 'secret comment', ...over });
    ok(await lead({ callAt: '2026-11-03T09:00', jobNumber: '2788', tradeId: el.id, jobTypeId: el.jobTypes[0].id, suburb: 'Kilburn (5084)' }));
    ok(await lead({ callAt: '2026-11-03T10:00', jobNumber: '2788 ', booked: 'No', tradeId: pl.id })); // not booked: ignored
    ok(await lead({ callAt: '2026-11-03T11:00', jobNumber: '27880', tradeId: pl.id })); // different Job Number
    const archived = ok(await lead({ callAt: '2026-11-03T12:00', jobNumber: '2788', tradeId: pl.id }));
    ok(await server.request('POST', '/archive/preview', { items: [{ kind: 'call', id: archived.id }], archived: true }).then(async (pv) => server.request('POST', '/archive/apply', { items: [{ kind: 'call', id: archived.id }], archived: true, token: pv.data.token })));

    const before = JSON.stringify(dbAll('SELECT * FROM calls ORDER BY id'));
    const r = ok(await server.request('GET', '/lookup/cancellation-origin?jn=2788'));
    assert.equal(r.source, 'leadCall');
    assert.deepEqual(r.calls.map((c) => [c.date, c.tradeId, c.jobTypeId, c.suburb]), [['2026-11-03', el.id, el.jobTypes[0].id, 'Kilburn (5084)']]);
    assert.ok(!JSON.stringify(r).includes('secret comment') && !('leadSourceId' in r.calls[0]) && !('direction' in r.calls[0]), 'no comments, Lead Source or contact method');
    assert.deepEqual(ok(await server.request('GET', '/lookup/cancellation-origin?jn=9999')), { found: false, source: null });
    assert.equal(JSON.stringify(dbAll('SELECT * FROM calls ORDER BY id')), before, 'nothing written');

    // A Technician & Sales job with that Job Number comes first.
    ok(await server.request('POST', '/tech/new-job', {
      kind: 'new_job_no_sale', visitDate: '2026-11-04', technicianId: tech.id, jobNumber: '2788', tradeId: pl.id, jobTypeId: pl.jobTypes[0].id,
      lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A', suburb: 'Prospect (5082)',
    }));
    const j = ok(await server.request('GET', '/lookup/cancellation-origin?jn=2788'));
    assert.deepEqual([j.source, j.job.tradeId, j.job.suburb], ['job', pl.id, 'Prospect (5082)']);
  } finally {
    server.close();
  }
});

const call = (over = {}) => ({ id: 1, date: '2026-11-03', tradeId: 2, trade: 'Electrical', jobTypeId: 21, jobType: 'Power Points', suburb: 'Kilburn (5084)', ...over });
const blank = { tradeId: '', jobTypeId: '', suburb: '' };

test('one booked Lead call: blank Trade, Job type and Suburb filled; staff entries kept with "Use this" for differences', () => {
  const origin = { found: true, source: 'leadCall', calls: [call()] };
  const p = planCancellationFill({ origin, form: blank, allowFill: true, jobNumber: '2788' });
  assert.deepEqual(p.wanted, { tradeId: 2, jobTypeId: 21, suburb: 'Kilburn (5084)' });
  assert.equal(cancellationFillConfirmation(p.sourceLabel, p.wanted), 'Filled from the booked Lead call for JN 2788 (3 Nov 2026): Trade, Job type, Suburb — still editable.');
  const kept = planCancellationFill({ origin, form: { tradeId: 3, jobTypeId: 31, suburb: 'Prospect (5082)' }, allowFill: true, jobNumber: '2788' });
  assert.deepEqual(kept.wanted, {});
  assert.deepEqual(kept.suggestions.map((s) => s.label), ['Trade / Job type: Electrical — Power Points', 'Suburb: Kilburn (5084)']);
});

test('several booked Lead calls: agreeing fields fill; conflicting ones are offered, never guessed; Trade/Job type stay as one pair', () => {
  const agree = planCancellationFill({ origin: { found: true, source: 'leadCall', calls: [call(), call({ id: 2, suburb: '' })] }, form: blank, allowFill: true, jobNumber: '2788' });
  assert.deepEqual(agree.wanted, { tradeId: 2, jobTypeId: 21, suburb: 'Kilburn (5084)' });
  const conflict = planCancellationFill({
    origin: { found: true, source: 'leadCall', calls: [call(), call({ id: 2, date: '2026-11-05', tradeId: 3, trade: 'Plumbing', jobTypeId: 31, jobType: 'Hot Water', suburb: 'Prospect (5082)' })] },
    form: blank,
    allowFill: true,
    jobNumber: '2788',
  });
  assert.deepEqual(conflict.wanted, {});
  assert.deepEqual(conflict.suggestions.map((s) => s.values), [{ tradeId: 2, jobTypeId: 21 }, { tradeId: 3, jobTypeId: 31 }, { suburb: 'Kilburn (5084)' }, { suburb: 'Prospect (5082)' }]);
  assert.equal(conflict.notes.length, 2);
});

test('a saved cancellation that already had a Job Number: nothing filled, differences offered; the job is used when there is one', () => {
  const origin = { found: true, source: 'leadCall', calls: [call()] };
  const p = planCancellationFill({ origin, form: blank, allowFill: false, jobNumber: '2788' });
  assert.deepEqual([p.wanted, p.suggestions.length], [{}, 2]);
  const job = planCancellationFill({ origin: { found: true, source: 'job', job: { tradeId: 3, trade: 'Plumbing', jobTypeId: 31, jobType: 'Hot Water', suburb: 'Prospect (5082)' } }, form: blank, allowFill: true, jobNumber: '2788' });
  assert.deepEqual(job.wanted, { tradeId: 3, jobTypeId: 31, suburb: 'Prospect (5082)' });
  assert.match(cancellationFillConfirmation(job.sourceLabel, job.wanted), /^Filled from the Technician & Sales job for JN 2788/);
  assert.deepEqual(planCancellationFill({ origin: { found: false }, form: blank, allowFill: true, jobNumber: '2788' }).wanted, {});
});
