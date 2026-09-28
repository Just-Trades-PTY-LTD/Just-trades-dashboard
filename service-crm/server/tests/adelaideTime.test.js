import test from 'node:test';
import assert from 'node:assert/strict';
import { weekdayOf, mondayOf, adelaideGeneratedAtLabel } from '../src/lib/adelaideTime.js';

test('weekdayOf/mondayOf are correct and independent of the server process timezone', () => {
  assert.equal(weekdayOf('2026-09-28'), 1, '28 Sept 2026 is a Monday');
  assert.equal(weekdayOf('2026-09-27'), 0, '27 Sept 2026 is a Sunday');
  assert.equal(mondayOf('2026-10-01'), '2026-09-28', 'Thursday 1 Oct belongs to the week starting Mon 28 Sept');
  assert.equal(mondayOf('2026-09-28'), '2026-09-28', 'Monday itself is its own week start');
  assert.equal(mondayOf('2026-09-27'), '2026-09-21', 'Sunday 27 Sept belongs to the prior week starting Mon 21 Sept');
});

test('adelaideGeneratedAtLabel resolves the correct Adelaide offset across both ACST and ACDT', () => {
  // 15 Jan 03:00 UTC — daylight saving is in effect in South Australia (ACDT, UTC+10:30) → 1:30pm.
  const summer = adelaideGeneratedAtLabel(new Date('2026-01-15T03:00:00Z'));
  assert.match(summer, /1:30\s*pm/i);
  // 15 Jul 03:00 UTC — standard time (ACST, UTC+9:30) → 12:30pm.
  const winter = adelaideGeneratedAtLabel(new Date('2026-07-15T03:00:00Z'));
  assert.match(winter, /12:30\s*pm/i);
});
