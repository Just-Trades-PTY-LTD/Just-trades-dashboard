import test from 'node:test';
import assert from 'node:assert/strict';

// findTaskByJobNumber() against a stubbed global.fetch — no live AroFlo
// account involved. AROFLO_PAT must be set before the client module graph
// is first imported, hence the dynamic import.
process.env.AROFLO_PAT = 'test-token';
process.env.AROFLO_BASE_URL = 'http://mock.test/v2';

const { findTaskByJobNumber } = await import('../src/aroflo/client.js');

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

// Serves `allTasks` 100 per page in whatever order the caller passes,
// recording every page requested.
function stubTaskPages(allTasks) {
  const original = global.fetch;
  const requests = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    requests.push(u);
    const page = Number(u.searchParams.get('page'));
    return jsonResponse(200, { items: allTasks.slice((page - 1) * 100, page * 100) });
  };
  return {
    requests,
    restore: () => {
      global.fetch = original;
    },
  };
}

const range = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => ({ id: `T${from - i}`, jobNumber: from - i }));

test('asks AroFlo for newest job numbers first', async () => {
  const stub = stubTaskPages(range(2600, 2401));
  try {
    const task = await findTaskByJobNumber('BU-1', 2572);
    assert.equal(task.id, 'T2572');
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].searchParams.get('sortBy'), 'jobnumber');
    assert.equal(stub.requests[0].searchParams.get('ascending'), 'false');
  } finally {
    stub.restore();
  }
});

test('stops paging once a descending page has gone below the target', async () => {
  // JN 2550 doesn't exist; page 1 is 2700..2601, page 2 is 2600..2501.
  const stub = stubTaskPages(range(2700, 2001).filter((t) => t.jobNumber !== 2550));
  try {
    const task = await findTaskByJobNumber('BU-1', 2550);
    assert.equal(task, null);
    assert.equal(stub.requests.length, 2);
  } finally {
    stub.restore();
  }
});

test('falls back to a full scan if the response is not actually sorted', async () => {
  // Ascending order (sortBy ignored): a target on the last page must still be found.
  const stub = stubTaskPages(range(2700, 2401).reverse());
  try {
    const task = await findTaskByJobNumber('BU-1', 2690);
    assert.equal(task.id, 'T2690');
    assert.equal(stub.requests.length, 3);
  } finally {
    stub.restore();
  }
});
