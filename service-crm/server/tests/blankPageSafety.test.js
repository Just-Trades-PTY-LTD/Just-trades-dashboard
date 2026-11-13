import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { summarizeLabour, summarizeVisits } from '../src/aroflo/activity.js';

test('AroFlo activity only ever passes plain text on (nested values never reach the screen)', () => {
  const [l] = summarizeLabour([{ date: { d: 1 }, startTime: '2026-11-13T08:00:00', finishTime: '2026-11-13T10:00:00', hours: 2, user: { givenName: 'Ryan', familyName: { x: 1 }, position: { name: 'Electrician', id: 'P1' } } }]);
  assert.deepEqual(l, { technician: 'Ryan', position: 'Electrician', date: '2026-11-13', start: '08:00', finish: '10:00', hours: 2 });
  const [v] = summarizeVisits([{ startTime: '2026-11-19T08:00:00', endTime: '2026-11-19T12:00:00', hours: 4, resource: { givenName: 'Cody', position: { id: 'P2' } } }]);
  assert.equal(v.position, '');
  assert.equal(v.technician, 'Cody');
});

test('a crashed screen can report its error to the server log (signed-in only, nothing stored)', async () => {
  const server = await startTestServer();
  try {
    const anon = await server.request('POST', '/client-error', { message: 'x' });
    assert.equal(anon.status, 401);
    await server.login();
    const ok = await server.request('POST', '/client-error', { screen: 'tech', message: 'Minified React error #31', stack: 'Error: ...' });
    assert.equal(ok.status, 204);
  } finally {
    server.close();
  }
});
