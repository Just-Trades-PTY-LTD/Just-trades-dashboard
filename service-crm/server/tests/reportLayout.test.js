import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('a saved report layout can be fetched back, per report key', async () => {
  const server = await startTestServer();
  try {
    await server.login();

    const empty = await server.request('GET', '/reports/layouts');
    assert.deepEqual(empty.data, {}, 'no saved layout yet returns an empty object, not an error');

    const layout = { kpis: { size: 'lg', collapsed: false }, byTrade: { size: 'sm', collapsed: true } };
    const save = await server.request('PUT', '/reports/layouts/calls', { layout });
    assert.equal(save.status, 200);

    const after = await server.request('GET', '/reports/layouts');
    assert.deepEqual(after.data.calls, layout);
    assert.equal(after.data.tech, undefined, 'saving the calls layout must not create a tech layout');
  } finally {
    server.close();
  }
});

test('saving a layout again overwrites the previous one for that report (upsert, not duplicate rows)', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    await server.request('PUT', '/reports/layouts/tech', { layout: { kpis: { size: 'md', collapsed: false } } });
    await server.request('PUT', '/reports/layouts/tech', { layout: { kpis: { size: 'sm', collapsed: true } } });

    const res = await server.request('GET', '/reports/layouts');
    assert.deepEqual(res.data.tech, { kpis: { size: 'sm', collapsed: true } });
  } finally {
    server.close();
  }
});

test('an unknown report key is rejected rather than silently saved', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const res = await server.request('PUT', '/reports/layouts/not-a-real-report', { layout: { kpis: { size: 'lg' } } });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("one user's saved layout is invisible to, and unaffected by, another user's layout", async () => {
  const server = await startTestServer();
  try {
    await server.login(); // admin
    await server.request('PUT', '/reports/layouts/calls', { layout: { kpis: { size: 'lg', collapsed: false } } });

    await server.request('POST', '/users', { name: 'Second User', email: 'second@justtrades.au', password: 'second-pass-123', role: 'staff' });
    await server.login('second@justtrades.au', 'second-pass-123');

    const secondUsersView = await server.request('GET', '/reports/layouts');
    assert.deepEqual(secondUsersView.data, {}, "a different user must not see the admin's saved layout");

    await server.request('PUT', '/reports/layouts/calls', { layout: { kpis: { size: 'sm', collapsed: true } } });

    await server.login(); // back to admin
    const adminsViewAfter = await server.request('GET', '/reports/layouts');
    assert.deepEqual(adminsViewAfter.data.calls, { kpis: { size: 'lg', collapsed: false } }, "the second user's save must not change the admin's own saved layout");
  } finally {
    server.close();
  }
});
