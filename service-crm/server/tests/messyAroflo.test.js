import test from 'node:test';
import assert from 'node:assert/strict';
import { asText, asTextOrNull, asMoney } from '../src/aroflo/values.js';

// Release guard: AroFlo's real data isn't tidy (numbers where text is
// expected, nested objects, missing fields). Every AroFlo lookup the screens
// use must still answer, and every value it passes on must be the type the
// screens expect — a numeric invoice number once blanked the Technician &
// Sales form. Add any new AroFlo lookup here.
process.env.AROFLO_PAT = 'test-token';
process.env.AROFLO_BASE_URL = 'http://messy.test/v2';
const { startTestServer } = await import('./helpers.js');

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => body });

// Two flavours of messy: numbers everywhere text is expected, and
// objects / nulls everywhere.
const FLAVOURS = {
  numbers: {
    task: { id: 'T1', jobNumber: 2600, status: 'PENDING', taskType: { name: 1234 }, description: 98765, client: { id: 'C1' }, locationText: 5108, location: { suburb: 5108, postCode: 5108, state: 'SA' }, schedule: { scheduleDate: '2026-11-20T00:00:00', resources: [{ name: 42 }] } },
    invoices: [{ id: 77, invoiceNumber: 2300, invoicedDateTime: '2026-11-13T00:00:00', totalAmountEx: '1,234.50', status: 3, type: 9 }],
    labours: [{ date: 20261113, startTime: 1, finishTime: 2, hours: '2', user: { givenName: 5, familyName: 6, position: 7 } }],
    schedules: [{ startTime: 5, endTime: 6, hours: 'x', resource: { givenName: 1, position: 2 } }],
    custom: [{ name: 'Lead Source', value: 12 }],
  },
  objects: {
    task: { id: 'T1', jobNumber: 2600, status: { name: 'PENDING' }, taskType: { name: { x: 1 } }, description: { html: '<p>x</p>' }, client: { id: 'C1' }, locationText: { a: 1 }, location: 'not an object', schedule: { scheduleDate: { d: 1 }, resources: 'none' } },
    invoices: [{ id: { v: 1 }, invoiceNumber: { n: 2300 }, invoicedDateTime: { d: 1 }, totalAmountEx: { v: 1 }, status: null, type: [] }, null],
    labours: [{ date: { d: 1 }, startTime: null, user: { givenName: { a: 1 }, position: { name: 'Electrician', id: 'P1' } } }],
    schedules: [{ resource: null }],
    custom: [{ name: 'Lead Source', value: { v: 'Google' } }],
  },
};

function fakeAroflo(original, f) {
  return async (url, init) => {
    const u = new URL(url);
    if (u.origin !== 'http://messy.test') return original(url, init);
    assert.equal(init?.method || 'GET', 'GET', 'AroFlo is read-only');
    const p = u.pathname;
    if (p === '/v2/businessunits') return json(200, { items: [{ id: 'BU-1' }] });
    if (p === '/v2/tasks') return json(200, { items: u.searchParams.get('page') === '1' ? [{ id: 'T1', jobNumber: 2600, client: { id: 'C1' } }] : [] });
    if (p === '/v2/tasks/T1') return json(200, f.task);
    if (p === '/v2/invoices') return json(200, { items: f.invoices });
    if (p === '/v2/tasks/T1/labours') return json(200, { items: f.labours });
    if (p === '/v2/schedules') return json(200, { items: f.schedules });
    if (p.startsWith('/v2/customfields/')) return json(200, { items: f.custom });
    return json(200, { items: [] });
  };
}

const isText = (v) => typeof v === 'string';
const isTextOrNull = (v) => v === null || typeof v === 'string';
const isMoneyOrNull = (v) => v === null || (typeof v === 'number' && Number.isFinite(v));

for (const [flavour, data] of Object.entries(FLAVOURS)) {
  test(`messy AroFlo (${flavour}): every lookup answers and passes on only the expected types`, async () => {
    const server = await startTestServer();
    const original = global.fetch;
    global.fetch = fakeAroflo(original, data);
    try {
      await server.login();

      const look = await server.request('GET', '/aroflo/lookup?jn=2600&activity=1');
      assert.equal(look.status, 200, JSON.stringify(look.data));
      const r = look.data;
      assert.equal(r.found, true);
      for (const k of ['status', 'taskType', 'description']) assert.ok(isText(r[k]), `${k}: ${JSON.stringify(r[k])}`);
      for (const k of ['suburb', 'addressForReference', 'leadSource']) assert.ok(isTextOrNull(r[k]), `${k}: ${JSON.stringify(r[k])}`);
      for (const inv of r.invoices) {
        for (const k of ['invoiceNumber', 'invoiceDate', 'status', 'type']) assert.ok(isText(inv[k]), `invoice ${k}: ${JSON.stringify(inv[k])}`);
        assert.ok(typeof inv.saleValueExGst === 'number' && Number.isFinite(inv.saleValueExGst), `saleValueExGst: ${inv.saleValueExGst}`);
      }
      if (r.scheduled) for (const k of ['technicianName', 'date']) assert.ok(isText(r.scheduled[k]), `scheduled ${k}`);
      for (const row of [...(r.activity?.labour || []), ...(r.activity?.visits || [])]) {
        for (const k of ['technician', 'position', 'date', 'start', 'finish']) assert.ok(isText(row[k]), `activity ${k}: ${JSON.stringify(row[k])}`);
        assert.ok(row.hours === null || typeof row.hours === 'number', `hours: ${row.hours}`);
      }

      const pc = await server.request('GET', '/aroflo/pending-cancellation-invoices?jn=2600');
      assert.equal(pc.status, 200, JSON.stringify(pc.data));
      for (const inv of pc.data.invoices) {
        assert.ok(isText(inv.invoiceNumber) && isText(inv.invoiceDate), JSON.stringify(inv));
        if (inv.aroflo) assert.ok(isText(inv.aroflo.status) && isMoneyOrNull(inv.aroflo.valueExGst), JSON.stringify(inv.aroflo));
      }

      const hist = await server.request('GET', '/aroflo/lead-history?jn=2600');
      assert.equal(hist.status, 200, JSON.stringify(hist.data));
    } finally {
      global.fetch = original;
      server.close();
    }
  });
}

test('AroFlo value cleaning', () => {
  assert.equal(asText(2300), '2300');
  assert.equal(asText(' 2300 '), '2300');
  assert.equal(asText({ n: 1 }), '');
  assert.equal(asText(null), '');
  assert.equal(asTextOrNull(''), null);
  assert.equal(asMoney('1,234.50'), 1234.5);
  assert.equal(asMoney({}), null);
  assert.equal(asMoney(NaN), null);
});
