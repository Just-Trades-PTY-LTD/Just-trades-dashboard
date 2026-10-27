import test from 'node:test';
import assert from 'node:assert/strict';
import { all as dbAll, run as dbRun } from '../src/db/index.js';

// Full-stack tests of the production New Job AroFlo lookup (GET
// /api/aroflo/lookup) — the clean, decided summary the real form uses, as
// opposed to the admin-only /aroflo-test page's raw data. AROFLO_PAT must be
// set before config.js (and everything importing it, including helpers.js's
// createApp()) is first loaded in this process — hence the dynamic imports
// below rather than static ones.
process.env.AROFLO_PAT = 'test-token-should-never-appear-anywhere';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';

const { startTestServer } = await import('./helpers.js');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

// Only AroFlo-bound requests are mocked — everything else (the test
// server's own local HTTP calls) goes through the real fetch untouched, so
// server.request()/login() keep working normally.
function stubAroFloFetch(handler) {
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.origin === 'http://mock.test') return handler(u, init);
    return original(url, init);
  };
  return () => {
    global.fetch = original;
  };
}

const TASK_BASE = {
  id: 'K890006XVB0',
  jobNumber: 2535,
  taskType: { name: 'Plumbing Maintenance' },
  location: null,
};

function mockAroFlo({ task, invoices = [], clientCustomFields }) {
  return stubAroFloFetch(async (u) => {
    if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
    if (u.pathname === '/v2/tasks') {
      const items = u.searchParams.get('page') === '1' ? [{ id: task.id, jobNumber: task.jobNumber }] : [];
      return jsonResponse(200, { items });
    }
    if (u.pathname === `/v2/tasks/${task.id}`) return jsonResponse(200, task);
    if (u.pathname === '/v2/invoices') return jsonResponse(200, { items: invoices });
    if (task.client?.id && u.pathname === `/v2/customfields/CLIENTS/${task.client.id}`) {
      return clientCustomFields ? jsonResponse(200, clientCustomFields) : jsonResponse(404, { error: 'not found' });
    }
    return jsonResponse(404, { error: 'not found' });
  });
}

test('a Pending task with a scheduled return visit, a matching technician and one invoice', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    await server.request('POST', '/settings/technicians', { name: 'Ryan Smith' });

    const restore = mockAroFlo({
      task: {
        ...TASK_BASE,
        status: 'PENDING',
        description: '<p>Connect power to shed.&nbsp;</p>',
        locationText: '40 Johnson Parade Blackwood SA 5159 AUSTRALIA',
        resources: [],
        schedule: { resources: [{ type: 'USER', name: 'Ryan Smith El Install' }], startTime: '2026-10-28T07:00:00' },
      },
      invoices: [{ id: 1, invoiceNumber: '2115', invoicedDateTime: '2026-10-07T00:00:00', totalAmountEx: 4757, status: 'IN_PROGRESS' }],
    });
    // Blackwood's real postcode is 5051, not 5159 — deliberately mismatched
    // here so this test's suburb match is self-contained rather than
    // depending on the real seeded list; add a matching row directly.
    dbRun("INSERT INTO suburbs (name, postcode) VALUES ('Blackwood', '5159')");

    try {
      const res = await server.request('GET', '/aroflo/lookup?jn=2535');
      assert.equal(res.status, 200);
      assert.equal(res.data.found, true);
      assert.equal(res.data.status, 'PENDING');
      assert.equal(res.data.taskType, 'Plumbing Maintenance');
      assert.equal(res.data.description, 'Connect power to shed.');
      assert.equal(res.data.suburb, 'Blackwood (5159)');
      assert.equal(res.data.invoices.length, 1);
      assert.deepEqual(res.data.invoices[0], { invoiceNumber: '2115', invoiceDate: '2026-10-07', saleValueExGst: 4757, status: 'IN_PROGRESS', isDraft: true });
      assert.ok(res.data.scheduled);
      assert.equal(res.data.scheduled.technicianName, 'Ryan Smith El Install');
      assert.equal(res.data.scheduled.date, '2026-10-28');
      // "Ryan Smith" (the CRM technician) is a substring of "Ryan Smith El
      // Install" (AroFlo's free-text name) — a confident match.
      const tech = (await server.request('GET', '/settings/bundle')).data.technicians.find((t) => t.name === 'Ryan Smith');
      assert.equal(res.data.scheduled.matchedTechnicianId, tech.id);
    } finally {
      restore();
    }
  } finally {
    server.close();
  }
});

test('a client with a Lead Source custom field: leadSource is surfaced as a plain reference value', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const restore = mockAroFlo({
      task: { ...TASK_BASE, status: 'COMPLETED', locationText: '', resources: [], schedule: null, client: { id: 'CLI-1' } },
      clientCustomFields: {
        count: 2,
        items: [
          { id: 'K89000229TR', customField: { name: 'Lead Source', value: 'Online Enquiry' } },
          { id: 'K89000229V0', customField: { name: 'Occupant', value: 'Homeowner' } },
        ],
      },
    });
    try {
      const res = await server.request('GET', '/aroflo/lookup?jn=2535');
      assert.equal(res.data.found, true);
      assert.equal(res.data.leadSource, 'Online Enquiry');
    } finally {
      restore();
    }
  } finally {
    server.close();
  }
});

test('no client, or no Lead Source field on the client: leadSource is null, never a thrown error', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const restore = mockAroFlo({
      task: { ...TASK_BASE, status: 'COMPLETED', locationText: '', resources: [], schedule: null },
    });
    try {
      const res = await server.request('GET', '/aroflo/lookup?jn=2535');
      assert.equal(res.data.found, true);
      assert.equal(res.data.leadSource, null);
    } finally {
      restore();
    }
  } finally {
    server.close();
  }
});

test('an ambiguous technician name (no CRM technician is a confident match) leaves matchedTechnicianId null', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    await server.request('POST', '/settings/technicians', { name: 'Someone Else' });

    const restore = mockAroFlo({
      task: {
        ...TASK_BASE,
        status: 'PENDING',
        locationText: 'no matching suburb here SA 0000 AUSTRALIA',
        resources: [],
        schedule: { resources: [{ type: 'USER', name: 'Totally Unrelated Name' }], startTime: '2026-10-28T07:00:00' },
      },
    });
    try {
      const res = await server.request('GET', '/aroflo/lookup?jn=2535');
      assert.equal(res.data.scheduled.technicianName, 'Totally Unrelated Name');
      assert.equal(res.data.scheduled.matchedTechnicianId, null);
      assert.equal(res.data.suburb, null, 'no suburb in this CRM shares that postcode');
    } finally {
      restore();
    }
  } finally {
    server.close();
  }
});

test('a Completed task with no schedule: found, but scheduled is null (the confirmed completed-job gap)', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const restore = mockAroFlo({
      task: { ...TASK_BASE, status: 'COMPLETED', locationText: '5 Moredun Street Tennyson SA 0001 AUSTRALIA', resources: [], schedule: null },
      invoices: [{ id: 1, invoiceNumber: '2159', invoicedDateTime: '2026-10-15T00:00:00', totalAmountEx: 978, status: 'APPROVED' }],
    });
    try {
      const res = await server.request('GET', '/aroflo/lookup?jn=2535');
      assert.equal(res.data.found, true);
      assert.equal(res.data.status, 'COMPLETED');
      assert.equal(res.data.scheduled, null);
      assert.equal(res.data.invoices.length, 1);
    } finally {
      restore();
    }
  } finally {
    server.close();
  }
});

test('no matching AroFlo job: found is false with a plain message, not an HTTP error', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const restore = stubAroFloFetch(async (u) => {
      if (u.pathname === '/v2/businessunits') return jsonResponse(200, { items: [{ id: 'BU-1' }] });
      if (u.pathname === '/v2/tasks') return jsonResponse(200, { items: [] });
      return jsonResponse(404, { error: 'not found' });
    });
    try {
      const res = await server.request('GET', '/aroflo/lookup?jn=NO-SUCH-JOB');
      assert.equal(res.status, 200);
      assert.equal(res.data.found, false);
      assert.match(res.data.message, /No matching AroFlo job/);
    } finally {
      restore();
    }
  } finally {
    server.close();
  }
});

test('a lookup never writes to the CRM database — no job, sale, or any other record is created', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const restore = mockAroFlo({
      task: {
        ...TASK_BASE,
        status: 'PENDING',
        locationText: '1 Example St SA 0002 AUSTRALIA',
        resources: [],
        schedule: { resources: [{ type: 'USER', name: 'Someone' }], startTime: '2026-10-28T07:00:00' },
      },
      invoices: [{ id: 1, invoiceNumber: '9999', invoicedDateTime: '2026-10-07T00:00:00', totalAmountEx: 100, status: 'APPROVED' }],
    });
    try {
      const before = { jobs: dbAll('SELECT * FROM jobs'), sales: dbAll('SELECT * FROM sales'), technicians: dbAll('SELECT * FROM technicians') };
      await server.request('GET', '/aroflo/lookup?jn=2535');
      const after = { jobs: dbAll('SELECT * FROM jobs'), sales: dbAll('SELECT * FROM sales'), technicians: dbAll('SELECT * FROM technicians') };
      assert.deepEqual(after, before);
    } finally {
      restore();
    }
  } finally {
    server.close();
  }
});
