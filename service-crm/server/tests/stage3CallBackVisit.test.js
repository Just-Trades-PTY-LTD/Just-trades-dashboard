import test from 'node:test';
import assert from 'node:assert/strict';
import { planCallBackVisit } from '../../client/src/lib/arofloPrefill.js';

// Stage 3: a Call Back entry's new callback Job Number — AroFlo's visit date
// and attending technician offered as "Use this" suggestions only.
const TECHS = [{ id: 3, name: 'Tylor', active: true }, { id: 4, name: 'Ryan', active: true }, { id: 5, name: 'Ryan Smith', active: false }];
const form = { visitDate: '2026-11-11', technicianId: '' };
const found = (activity, extra = {}) => ({ found: true, activity, ...extra });

test('one booked visit with one matching technician: both suggested, nothing applied', () => {
  const p = planCallBackVisit({ result: found({ visits: [{ date: '2026-11-05', technician: 'Tylor Example' }], labour: [] }), form, technicians: TECHS });
  assert.deepEqual(p, { date: '2026-11-05', source: 'visit', technicianId: '3', technicianName: 'Tylor Example', dateApplied: false, technicianApplied: false, note: null });
  const applied = planCallBackVisit({ result: found({ visits: [{ date: '2026-11-05', technician: 'Tylor Example' }] }), form: { visitDate: '2026-11-05', technicianId: '3' }, technicians: TECHS });
  assert.deepEqual([applied.dateApplied, applied.technicianApplied], [true, true]);
});

test('no visits booked: the day time was logged is used instead', () => {
  const p = planCallBackVisit({ result: found({ visits: [], labour: [{ date: '2026-11-06', technician: 'Ryan Jones' }] }), form, technicians: TECHS });
  assert.deepEqual([p.date, p.source, p.technicianId], ['2026-11-06', 'time logged', '4']);
});

test('several dates, several people, or no technician match: left for staff with a note', () => {
  let p = planCallBackVisit({ result: found({ visits: [{ date: '2026-11-05', technician: 'Tylor' }, { date: '2026-11-07', technician: 'Tylor' }] }), form, technicians: TECHS });
  assert.equal(p.date, undefined);
  assert.match(p.note, /2 different dates \(2026-11-05, 2026-11-07\)/);
  p = planCallBackVisit({ result: found({ visits: [{ date: '2026-11-05', technician: 'Tylor' }, { date: '2026-11-05', technician: 'Ryan' }] }), form, technicians: TECHS });
  assert.deepEqual([p.date, p.technicianId], ['2026-11-05', null]);
  assert.match(p.note, /2 people are on that visit/);
  p = planCallBackVisit({ result: found({ visits: [{ date: '2026-11-05', technician: 'Someone Else' }] }), form, technicians: TECHS });
  assert.deepEqual([p.date, p.technicianId, p.technicianApplied], ['2026-11-05', null, true]);
  assert.match(p.note, /doesn't match exactly one technician/);
});

test('nothing booked or logged yet; activity unreadable falls back to the pending schedule; not found', () => {
  assert.match(planCallBackVisit({ result: found({ visits: [], labour: [] }), form, technicians: TECHS }).note, /no visit booked or time logged/);
  const p = planCallBackVisit({ result: found(undefined, { scheduled: { date: '2026-11-09', technicianName: 'Tylor', matchedTechnicianId: 3 } }), form, technicians: TECHS });
  assert.deepEqual([p.date, p.technicianId], ['2026-11-09', '3']);
  assert.equal(planCallBackVisit({ result: { found: false }, form, technicians: TECHS }), null);
});
