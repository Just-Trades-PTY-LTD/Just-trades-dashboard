import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { startTestServer } from './helpers.js';
import { all as dbAll, get as dbGet, run as dbRun } from '../src/db/index.js';

// Lead Qualification rules for New Job entries (server/src/lib/leadRules.js):
// Not Qualified No Sale -> sheets N/A, no knock-back; Sale Made is always
// Qualified; Lead changes recalculate the knock-back flag but are refused
// while a job has an open follow-up or a Converted Later link; a refused
// edit changes nothing; older records are never corrected automatically.

async function setup(server) {
  await server.login();
  const b = (await server.request('GET', '/settings/bundle')).data;
  const plumbing = b.trades.find((t) => t.name === 'Plumbing');
  const tech = (await server.request('POST', '/settings/technicians', { name: 'LQ Tech' })).data;
  return { plumbing, jobTypeId: plumbing.jobTypes[0].id, reasonId: b.lists.knockback_reason[0].id, tech };
}

function newJob(server, ctx, { jobNumber, kind = 'new_job_no_sale', lead, inspectionSheet = '', optionSheet = '', knockbackReasonId, extra = {} }) {
  return server.request('POST', '/tech/new-job', {
    kind,
    visitDate: '2026-05-01',
    technicianId: ctx.tech.id,
    jobNumber,
    tradeId: ctx.plumbing.id,
    jobTypeId: ctx.jobTypeId,
    lead,
    inspectionSheet,
    optionSheet,
    knockbackReasonId: knockbackReasonId === undefined ? (kind === 'new_job_no_sale' && lead === 'Qualified' ? ctx.reasonId : null) : knockbackReasonId,
    ...(kind === 'new_job_sale_made' ? { invoiceNumber: `INV-${jobNumber}`, invoiceDate: '2026-05-01', saleValueExGst: 500 } : {}),
    ...extra,
  });
}

const row = (id) => dbGet('SELECT * FROM jobs WHERE id = ?', [id]);
const report = async (server) => (await server.request('GET', '/reports/tech?from=2026-05-01&to=2026-05-31')).data.company;

// ---------- New entries ----------

test('new Not Qualified No Sale: sheets saved as N/A, no knock-back, no reason', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const res = await newJob(server, ctx, { jobNumber: 'LQ-1', lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: '' });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const j = row(res.data.entry.id);
    assert.deepEqual([j.inspection_sheet, j.option_sheet, j.knockback, j.knockback_reason_id], ['N/A', 'N/A', 0, null]);
  } finally {
    server.close();
  }
});

test('new Not Qualified No Sale with a Yes/No sheet or a knock-back reason is refused and nothing is created', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const before = dbAll('SELECT COUNT(*) n FROM jobs')[0].n;
    for (const body of [
      { jobNumber: 'LQ-2', lead: 'Not Qualified', inspectionSheet: 'Yes' },
      { jobNumber: 'LQ-3', lead: 'Not Qualified', optionSheet: 'No' },
      { jobNumber: 'LQ-4', lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A', knockbackReasonId: ctx.reasonId },
    ]) {
      const res = await newJob(server, ctx, body);
      assert.equal(res.status, 400, body.jobNumber);
    }
    assert.equal(dbAll('SELECT COUNT(*) n FROM jobs')[0].n, before);
  } finally {
    server.close();
  }
});

test('new Sale Made can never be saved as Not Qualified', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const res = await newJob(server, ctx, { jobNumber: 'LQ-5', kind: 'new_job_sale_made', lead: 'Not Qualified' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /always Qualified/);
    assert.equal(dbAll('SELECT COUNT(*) n FROM sales')[0].n, 0, 'no sale created either');
    const ok = await newJob(server, ctx, { jobNumber: 'LQ-6', kind: 'new_job_sale_made', lead: 'Qualified', inspectionSheet: 'Yes' });
    assert.equal(ok.status, 201);
    assert.equal(row(ok.data.entry.id).lead, 'Qualified');
  } finally {
    server.close();
  }
});

test('Qualified No Sale is unchanged: sheets optional, reason required, counts as a knock-back', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    assert.equal((await newJob(server, ctx, { jobNumber: 'LQ-7', lead: 'Qualified', knockbackReasonId: null })).status, 400, 'reason still required');
    const res = await newJob(server, ctx, { jobNumber: 'LQ-8', lead: 'Qualified' });
    assert.equal(res.status, 201);
    const j = row(res.data.entry.id);
    assert.deepEqual([j.inspection_sheet, j.option_sheet, j.knockback], ['', '', 1], 'blank sheets stay blank — not N/A, not required');
    assert.equal((await newJob(server, ctx, { jobNumber: 'LQ-9', lead: 'Qualified', inspectionSheet: 'No', optionSheet: 'Yes' })).status, 201);
  } finally {
    server.close();
  }
});

// ---------- Edits ----------

test('Qualified -> Not Qualified on an ordinary job: knock-back recalculated, sheets N/A, reason cleared', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const { id } = (await newJob(server, ctx, { jobNumber: 'LQ-10', lead: 'Qualified', inspectionSheet: 'No', optionSheet: 'Yes' })).data.entry;
    assert.equal((await report(server)).knockbacks, 1);
    const res = await server.request('PATCH', `/tech/new-job/${id}`, { lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A', knockbackReasonId: null });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const j = row(id);
    assert.deepEqual([j.lead, j.inspection_sheet, j.option_sheet, j.knockback, j.knockback_reason_id], ['Not Qualified', 'N/A', 'N/A', 0, null]);
    const r = await report(server);
    assert.equal(r.knockbacks, 0);
    assert.equal(r.qualifiedJobs, 0);
    assert.equal(r.inspectionRate, null, 'the N/A no longer counts as a No');
  } finally {
    server.close();
  }
});

test('Qualified -> Not Qualified that would keep a Yes/No sheet or the reason is refused, record unchanged', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const { id } = (await newJob(server, ctx, { jobNumber: 'LQ-11', lead: 'Qualified', inspectionSheet: 'Yes' })).data.entry;
    const before = row(id);
    assert.equal((await server.request('PATCH', `/tech/new-job/${id}`, { lead: 'Not Qualified', inspectionSheet: 'Yes', knockbackReasonId: null })).status, 400);
    assert.equal((await server.request('PATCH', `/tech/new-job/${id}`, { lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A' })).status, 400, 'reason not cleared');
    assert.deepEqual(row(id), before);
  } finally {
    server.close();
  }
});

test('Not Qualified -> Qualified: needs a reason, becomes a knock-back, and a later Quote Approved Later converts it', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const { id } = (await newJob(server, ctx, { jobNumber: 'LQ-12', lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A' })).data.entry;
    const before = row(id);
    assert.equal((await server.request('PATCH', `/tech/new-job/${id}`, { lead: 'Qualified', inspectionSheet: '', optionSheet: '' })).status, 400);
    assert.deepEqual(row(id), before, 'refused without a reason, nothing changed');
    const ok = await server.request('PATCH', `/tech/new-job/${id}`, { lead: 'Qualified', inspectionSheet: '', optionSheet: '', knockbackReasonId: ctx.reasonId });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(row(id).knockback, 1, 'stored knock-back flag now matches Lead');
    await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'LQ-12', newJobNumber: 'AF-LQ-12', dateLogged: '2026-05-10', creditedTechnicianId: ctx.tech.id, invoiceNumber: 'INV-LQ-12', invoiceDate: '2026-05-10', saleValueExGst: 700 });
    assert.equal(row(id).converted_later, 1, 'the converted-later flip now works for a re-qualified job');
  } finally {
    server.close();
  }
});

test('a Lead change is refused while the job has an open follow-up; allowed once it is closed', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const { id } = (await newJob(server, ctx, { jobNumber: 'LQ-13', lead: 'Qualified' })).data.entry;
    const fu = (await server.request('POST', '/follow-ups', { jobId: id, dueDate: '2026-05-11' })).data;
    const before = row(id);
    const fuBefore = dbAll('SELECT * FROM follow_ups');
    const res = await server.request('PATCH', `/tech/new-job/${id}`, { lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A', knockbackReasonId: null, comments: 'also changed' });
    assert.equal(res.status, 409);
    assert.match(res.data.error, /open follow-up.*resolved separately.*Nothing was changed/);
    assert.deepEqual(row(id), before, 'whole record unchanged, including the comment sent alongside');
    assert.deepEqual(dbAll('SELECT * FROM follow_ups'), fuBefore, 'follow-up untouched');
    // Other edits to the same job still work.
    assert.equal((await server.request('PATCH', `/tech/new-job/${id}`, { comments: 'note only' })).status, 200);
    await server.request('PATCH', `/follow-ups/${fu.id}/close`, { outcome: 'no_longer_required' });
    assert.equal((await server.request('PATCH', `/tech/new-job/${id}`, { lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A', knockbackReasonId: null })).status, 200);
  } finally {
    server.close();
  }
});

test('a Lead change is refused on a job linked to a Converted Later sale; the link is left alone', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const { id } = (await newJob(server, ctx, { jobNumber: 'LQ-14', lead: 'Qualified' })).data.entry;
    await server.request('POST', '/tech/quote-approved-later', { jobNumber: 'LQ-14', newJobNumber: 'AF-LQ-14', dateLogged: '2026-05-10', creditedTechnicianId: ctx.tech.id, invoiceNumber: 'INV-LQ-14', invoiceDate: '2026-05-10', saleValueExGst: 700 });
    const before = row(id);
    const salesBefore = dbAll('SELECT * FROM sales');
    const res = await server.request('PATCH', `/tech/new-job/${id}`, { lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A', knockbackReasonId: null });
    assert.equal(res.status, 409);
    assert.match(res.data.error, /Converted Later.*conversion link.*resolved separately/);
    assert.deepEqual(row(id), before);
    assert.deepEqual(dbAll('SELECT * FROM sales'), salesBefore);
  } finally {
    server.close();
  }
});

test('Sale Made can’t be changed to Not Qualified; an older Sale Made + Not Qualified must be set to Qualified to save', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const { id } = (await newJob(server, ctx, { jobNumber: 'LQ-15', kind: 'new_job_sale_made', lead: 'Qualified' })).data.entry;
    let before = row(id);
    assert.equal((await server.request('PATCH', `/tech/new-job/${id}`, { lead: 'Not Qualified' })).status, 400);
    assert.deepEqual(row(id), before);

    // Older data, as it may already exist: flagged, never silently corrected.
    dbRun("UPDATE jobs SET lead = 'Not Qualified' WHERE id = ?", [id]);
    before = row(id);
    const blocked = await server.request('PATCH', `/tech/new-job/${id}`, { comments: 'typo fix' });
    assert.equal(blocked.status, 400);
    assert.match(blocked.data.error, /marked Not Qualified.*Change Lead to Qualified/);
    assert.deepEqual(row(id), before);
    const fixed = await server.request('PATCH', `/tech/new-job/${id}`, { lead: 'Qualified', comments: 'typo fix' });
    assert.equal(fixed.status, 200);
    assert.deepEqual([row(id).lead, row(id).knockback], ['Qualified', 0], 'a Sale Made job is never a knock-back');
  } finally {
    server.close();
  }
});

test('older Not Qualified jobs with a Yes/No sheet are left as they are on unrelated edits', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const { id } = (await newJob(server, ctx, { jobNumber: 'LQ-16', lead: 'Not Qualified' })).data.entry;
    dbRun("UPDATE jobs SET inspection_sheet = 'No', option_sheet = 'Yes' WHERE id = ?", [id]); // as saved before this rule
    assert.equal((await server.request('PATCH', `/tech/new-job/${id}`, { comments: 'note', inspectionSheet: 'No', optionSheet: 'Yes' })).status, 200);
    assert.deepEqual([row(id).inspection_sheet, row(id).option_sheet], ['No', 'Yes'], 'not corrected automatically');
    assert.equal((await server.request('PATCH', `/tech/new-job/${id}`, { optionSheet: 'No' })).status, 400, 'but no new Yes/No');
    assert.equal((await server.request('PATCH', `/tech/new-job/${id}`, { inspectionSheet: 'N/A', optionSheet: 'N/A' })).status, 200, 'staff can set N/A');
  } finally {
    server.close();
  }
});

test('ordinary edits that leave Lead alone keep the stored knock-back flag exactly as it was', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    const { id } = (await newJob(server, ctx, { jobNumber: 'LQ-17', lead: 'Qualified' })).data.entry;
    dbRun('UPDATE jobs SET knockback = 0 WHERE id = ?', [id]); // an older, inconsistent flag
    assert.equal((await server.request('PATCH', `/tech/new-job/${id}`, { comments: 'note', lead: 'Qualified' })).status, 200);
    assert.equal(row(id).knockback, 0, 'not reinterpreted by an unrelated edit');
  } finally {
    server.close();
  }
});

// ---------- Reports, click-through and exports ----------

test('N/A is excluded from sheet percentages and drill-downs; Knock back reads N/A in exports', async () => {
  const server = await startTestServer();
  try {
    const ctx = await setup(server);
    await newJob(server, ctx, { jobNumber: 'LQ-20', lead: 'Qualified', inspectionSheet: 'Yes', optionSheet: 'Yes' });
    await newJob(server, ctx, { jobNumber: 'LQ-21', lead: 'Qualified', inspectionSheet: 'No', optionSheet: 'Yes' });
    await newJob(server, ctx, { jobNumber: 'LQ-22', lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A' });
    await newJob(server, ctx, { jobNumber: 'LQ-23', lead: 'Not Qualified', inspectionSheet: 'N/A', optionSheet: 'N/A' });

    const r = await report(server);
    assert.equal(r.inspectionRate, 50, '1 Yes of 2 answered — the two N/A are not counted as No');
    assert.equal(r.optionRate, 100);
    assert.equal(r.knockbacks, 2);
    assert.equal(r.knockbackRate, 100, 'knock-back % over the 2 Qualified jobs only');

    const dd = (await server.request('GET', '/reports/tech/drilldown?from=2026-05-01&to=2026-05-31&metric=inspectionRate')).data;
    const jns = JSON.stringify(dd);
    assert.ok(!jns.includes('LQ-22') && !jns.includes('LQ-23'), 'N/A jobs are not in the inspection-rate click-through');
    assert.ok(jns.includes('LQ-20') && jns.includes('LQ-21'), 'the Yes and No jobs are in it');

    const csv = (await server.rawGet('/export/tech-entries.csv')).buffer.toString();
    const line = (jn) => csv.split('\n').find((l) => l.includes(jn));
    assert.match(line('LQ-22'), /N\/A/);

    const xlsx = await server.rawGet('/tech/entries/export.xlsx?from=2026-05-01&to=2026-05-31');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.buffer);
    const cells = [];
    wb.worksheets.forEach((ws) => ws.eachRow((rr) => cells.push(rr.values.join('|'))));
    const xRow = (jn) => cells.find((c) => c.includes(jn)) || '';
    assert.match(xRow('LQ-22'), /\|N\/A\|/, 'Not Qualified job reads N/A');
    assert.match(xRow('LQ-20'), /\|Yes\|/);
  } finally {
    server.close();
  }
});
