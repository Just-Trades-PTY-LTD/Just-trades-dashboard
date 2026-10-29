import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';

// PATCH /users/:id must never leave the CRM without an active administrator
// (deactivating OR changing the last one to staff), and a refused request
// must not leave any part of itself saved.

const users = () => dbAll('SELECT id, name, role, active FROM users ORDER BY id');

test('the last active administrator cannot be changed to staff', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const before = users();
    const res = await server.request('PATCH', '/users/1', { role: 'staff' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /last active administrator/);
    assert.deepEqual(users(), before);
    assert.equal((await server.request('GET', '/users')).status, 200, 'still an admin');
  } finally {
    server.close();
  }
});

test('an administrator can be changed to staff once another active administrator exists', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const second = (await server.request('POST', '/users', { name: 'Second Admin', email: 'second@test.local', password: 'password123', role: 'admin' })).data;
    const res = await server.request('PATCH', `/users/${second.id}`, { role: 'staff' });
    assert.equal(res.status, 200);
    assert.equal(res.data.role, 'staff');
  } finally {
    server.close();
  }
});

test('an inactive administrator does not count towards keeping one active', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const second = (await server.request('POST', '/users', { name: 'Old Admin', email: 'old@test.local', password: 'password123', role: 'admin' })).data;
    assert.equal((await server.request('PATCH', `/users/${second.id}`, { active: false })).status, 200);
    const res = await server.request('PATCH', '/users/1', { role: 'staff' });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('a refused request saves nothing, not even the fields that were fine', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const before = users();
    // Renaming yourself while trying to deactivate yourself: both refused.
    const self = await server.request('PATCH', '/users/1', { name: 'Renamed', active: false });
    assert.equal(self.status, 400);
    // Renaming another user with a too-short password: both refused.
    const staff = (await server.request('POST', '/users', { name: 'Staff Sam', email: 'sam@test.local', password: 'password123', role: 'staff' })).data;
    const afterCreate = users();
    const shortPw = await server.request('PATCH', `/users/${staff.id}`, { name: 'Samuel', password: 'short' });
    assert.equal(shortPw.status, 400);
    assert.deepEqual(users(), afterCreate);
    assert.equal(before[0].name, users()[0].name);
  } finally {
    server.close();
  }
});

test('normal edits still work: rename, role change, deactivate, password', async () => {
  const server = await startTestServer();
  try {
    await server.login();
    const staff = (await server.request('POST', '/users', { name: 'Staff Sam', email: 'sam@test.local', password: 'password123', role: 'staff' })).data;
    const res = await server.request('PATCH', `/users/${staff.id}`, { name: 'Samuel', role: 'admin', password: 'newpassword1' });
    assert.equal(res.status, 200);
    assert.equal(res.data.name, 'Samuel');
    assert.equal(res.data.role, 'admin');
    assert.equal((await server.request('PATCH', `/users/${staff.id}`, { active: false })).status, 200);
    await server.login('sam@test.local', 'newpassword1').then(
      () => assert.fail('a deactivated user should not be able to log in'),
      () => {},
    );
  } finally {
    server.close();
  }
});
