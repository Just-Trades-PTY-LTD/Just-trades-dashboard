import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

// Settings → Suburbs → Add suburb: a name and a 4-digit postcode are both
// required; a suburb already in the list is refused with a clear message.

test('Add suburb: needs a name and a 4-digit postcode, and refuses one already in the list', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const add = (name, postcode) => server.request('POST', '/settings/suburbs', { name, postcode });

    assert.equal((await add('', '5501')).data.error, 'Enter the suburb name.');
    assert.equal((await add('Testwells', '')).data.error, 'Enter the 4-digit postcode.');
    assert.equal((await add('Testwells', '55')).status, 400);
    assert.equal((await add('New suburb', '')).status, 400, 'the old blank placeholder can no longer be created');

    const ok = await add('  Test   Wells ', '5501');
    assert.equal(ok.status, 201);
    assert.deepEqual([ok.data.name, ok.data.postcode], ['Test Wells', '5501']);

    const dupe = await add('test wells', '5501');
    assert.equal(dupe.status, 409);
    assert.equal(dupe.data.error, 'Test Wells (5501) is already in the list.');
    assert.equal(dupe.data.existing.id, ok.data.id);

    // Same name with a different postcode is a different suburb.
    assert.equal((await add('Test Wells', '5502')).status, 201);

    const list = (await server.request('GET', '/settings/suburbs?q=Test%20Wells&page=1&pageSize=50')).data;
    assert.deepEqual(list.rows.map((r) => `${r.name} ${r.postcode}`), ['Test Wells 5501', 'Test Wells 5502']);
  } finally {
    server.close();
  }
});
