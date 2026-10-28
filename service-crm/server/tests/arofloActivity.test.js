import test from 'node:test';
import assert from 'node:assert/strict';
import { toLocalDateTime, summarizeLabour, summarizeVisits } from '../src/aroflo/activity.js';

// Shapes below are taken from real AroFlo responses seen on the test page
// (JN 2432 and two completed jobs), with contact details kept in to prove
// they're dropped.

test('UTC schedule times are converted to Adelaide time (the real JN 2432 visit)', () => {
  // 2026-10-27T20:30Z is 7:00am on 28 Oct in Adelaide (ACDT, UTC+10:30) —
  // matching what AroFlo's own task summary showed for the same visit.
  assert.deepEqual(toLocalDateTime('2026-10-27T20:30:00.000Z'), { date: '2026-10-28', time: '07:00' });
  assert.deepEqual(toLocalDateTime('2026-10-28T05:30:00.000Z'), { date: '2026-10-28', time: '16:00' });
});

test('Adelaide standard time (UTC+9:30) is handled outside daylight saving too', () => {
  assert.deepEqual(toLocalDateTime('2026-06-14T22:00:00Z'), { date: '2026-06-15', time: '07:30' });
});

test('local times without an offset (labour) are read as-is, never shifted', () => {
  assert.deepEqual(toLocalDateTime('2026-10-26T13:58:00'), { date: '2026-10-26', time: '13:58' });
  assert.deepEqual(toLocalDateTime('2026-10-07'), { date: '2026-10-07', time: '' });
});

test('missing or unreadable times come back blank rather than guessed', () => {
  assert.deepEqual(toLocalDateTime(null), { date: '', time: '' });
  assert.deepEqual(toLocalDateTime('not a date'), { date: '', time: '' });
  assert.deepEqual(toLocalDateTime('garbageZ'), { date: '', time: '' });
});

const CODY = {
  id: 'K8900018668',
  givenName: 'Cody W',
  familyName: 'El Service',
  position: 'Electrician - Service Technician',
  email: 'codyw@example.test',
  mobile: '0400 000 000',
  avatar: 'https://ui-avatars.example/x',
};
const RYAN = { ...CODY, id: 'K8900017S88', givenName: 'Ryan S', familyName: 'El Install', position: 'Electrician - Installer', email: 'ryans@example.test' };

test('labour: names, dates, times and hours only, sorted oldest first', () => {
  const rows = summarizeLabour([
    { date: '2026-10-22', startTime: '2026-10-22T06:57:00', finishTime: '2026-10-22T10:06:00', hours: '3.15', costRate: 55, user: CODY },
    { date: '2026-10-21', startTime: '2026-10-21T12:27:00', finishTime: '2026-10-21T17:30:00', hours: '5.05', user: CODY },
    { date: '2026-10-21', startTime: '2026-10-21T06:58:00', finishTime: '2026-10-21T15:31:00', hours: '8.55', user: RYAN },
  ]);
  assert.deepEqual(rows, [
    { technician: 'Ryan S El Install', position: 'Electrician - Installer', date: '2026-10-21', start: '06:58', finish: '15:31', hours: 8.55 },
    { technician: 'Cody W El Service', position: 'Electrician - Service Technician', date: '2026-10-21', start: '12:27', finish: '17:30', hours: 5.05 },
    { technician: 'Cody W El Service', position: 'Electrician - Service Technician', date: '2026-10-22', start: '06:57', finish: '10:06', hours: 3.15 },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /example\.test|0400|avatar|Rate|K890/);
});

test('booked visits: converted to Adelaide time, contact details dropped', () => {
  const rows = summarizeVisits([
    { startTime: '2026-10-27T20:30:00.000Z', endTime: '2026-10-28T05:30:00.000Z', hours: 9, resource: RYAN, task: { jobNumber: 2432 } },
  ]);
  assert.deepEqual(rows, [
    { technician: 'Ryan S El Install', position: 'Electrician - Installer', date: '2026-10-28', start: '07:00', finish: '16:00', hours: 9 },
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /example\.test|0400|avatar|K890/);
});

test("AroFlo couldn't answer (null) stays null so the form can say so; an empty list stays empty", () => {
  assert.equal(summarizeLabour(null), null);
  assert.equal(summarizeVisits(null), null);
  assert.deepEqual(summarizeVisits([]), []);
});
