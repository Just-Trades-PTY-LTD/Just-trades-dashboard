import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { all as dbAll } from '../src/db/index.js';
import { analyzeTaskSuburb, matchSuburbForTask, matchSuburbFromLocationText, legacyMatchSuburbFromLocationText } from '../src/aroflo/suburbMatch.js';

// The shared AroFlo suburb matcher (Calls & Contacts and Technician & Sales),
// against the real seeded South Australian suburb list: the job's own site
// address only, suburb and postcode must agree, the longest name wins, and
// anything uncertain is left blank with a reason.

const text = (t) => analyzeTaskSuburb({ locationText: t });

test('accepted formats: SA / South Australia, commas, extra spaces, with or without AUSTRALIA', async () => {
  const server = await startTestServer();
  try {
    for (const a of [
      '65 Tyne Avenue Kilburn SA 5084 AUSTRALIA',
      '12 Smith Street Kilburn SA 5084',
      '12 Smith Street Kilburn South Australia 5084',
      '12 Smith Street, Kilburn, SA 5084, Australia',
      '12  smith st   kilburn  sa  5084  australia',
      'Kilburn SA 5084',
      '12 Smith Street Kilburn S.A. 5084',
    ]) {
      assert.deepEqual(text(a), { suburb: 'Kilburn (5084)', status: 'matched', reason: null, source: 'job address' }, a);
    }
  } finally {
    server.close();
  }
});

test('overlapping names: the longest valid suburb wins, and a street named after another suburb is ignored', async () => {
  const server = await startTestServer();
  try {
    const cases = {
      '4 Beach Road North Brighton SA 5048 AUSTRALIA': 'North Brighton (5048)',
      '9 Ocean Street South Brighton SA 5048 AUSTRALIA': 'South Brighton (5048)',
      '20 Jetty Road Brighton SA 5048 AUSTRALIA': 'Brighton (5048)',
      '7 Smart Road Modbury North SA 5092 AUSTRALIA': 'Modbury North (5092)',
      '15 Anzac Highway Glenelg North SA 5045 AUSTRALIA': 'Glenelg North (5045)',
      'Unit 3/12 Smith Street Woodville West SA 5011 AUSTRALIA': 'Woodville West (5011)',
      '1 Glynde Road Firle SA 5070 AUSTRALIA': 'Firle (5070)',
      '5 Kensington Road Kensington Park SA 5068 AUSTRALIA': 'Kensington Park (5068)',
    };
    for (const [a, want] of Object.entries(cases)) {
      assert.equal(matchSuburbFromLocationText(a), want, a);
      assert.equal(legacyMatchSuburbFromLocationText(a) === want, a.includes('Jetty Road Brighton'), `today's matcher only gets the plain-Brighton case right: ${a}`);
    }
  } finally {
    server.close();
  }
});

test('left blank, with a reason: missing postcode, interstate, mismatched or misspelt suburb, postcode not listed', async () => {
  const server = await startTestServer();
  try {
    const blank = {
      '12 Smith Street Kilburn SA': ['rejected', /no "SA" \+ postcode/],
      '1 George Street Sydney NSW 2000 AUSTRALIA': ['rejected', /outside South Australia/],
      '10 Main Road Prospect SA 5084 AUSTRALIA': ['uncertain', /no CRM suburb for postcode 5084/],
      '7 Smart Road Modbery North SA 5092 AUSTRALIA': ['uncertain', /misspelt/],
      '1 Nowhere Road Faketown SA 0999 AUSTRALIA': ['rejected', /postcode 0999 isn't in the CRM suburb list/],
      '': ['rejected', /no job address/],
    };
    for (const [a, [status, reason]] of Object.entries(blank)) {
      const r = text(a);
      assert.equal(r.suburb, null, a);
      assert.equal(r.status, status, a);
      assert.match(r.reason, reason, a);
    }
    assert.equal(matchSuburbForTask({}), null);
    assert.equal(matchSuburbForTask(null), null);
  } finally {
    server.close();
  }
});

test('site record: used when AroFlo has one, must agree with the CRM list and with the job address', async () => {
  const server = await startTestServer();
  try {
    assert.equal(matchSuburbForTask({ location: { suburb: 'South Brighton', state: 'SA', postCode: '5048' }, locationText: null }), 'South Brighton (5048)');
    assert.equal(matchSuburbForTask({ location: { suburb: 'south  brighton', postCode: '5048' } }), 'South Brighton (5048)', 'case/spacing tolerant');
    assert.equal(analyzeTaskSuburb({ location: { suburb: 'Brighton', state: 'SA', postCode: '5084' } }).status, 'uncertain', 'suburb/postcode disagree');
    assert.equal(analyzeTaskSuburb({ location: { suburb: 'Sydney', state: 'NSW', postCode: '2000' } }).status, 'rejected');
    // Site record and address text both matched but disagree: never guess.
    const conflict = analyzeTaskSuburb({ location: { suburb: 'Brighton', state: 'SA', postCode: '5048' }, locationText: '9 Ocean Street South Brighton SA 5048' });
    assert.equal(conflict.suburb, null);
    assert.equal(conflict.status, 'uncertain');
    // An empty site record falls back to the job address text.
    assert.equal(matchSuburbForTask({ location: null, locationText: '65 Tyne Avenue Kilburn SA 5084 AUSTRALIA' }), 'Kilburn (5084)');
    assert.equal(matchSuburbForTask({ location: { suburb: 'Kilburn', postCode: '' }, locationText: '9 Ocean Street South Brighton SA 5048' }), 'South Brighton (5048)', 'incomplete site record ignored');
  } finally {
    server.close();
  }
});

test('every seeded SA suburb is matched correctly in AroFlo\'s standard address format', async () => {
  const server = await startTestServer();
  try {
    const suburbs = dbAll('SELECT name, postcode FROM suburbs');
    assert.ok(suburbs.length > 1500);
    const wrong = suburbs.filter((s) => matchSuburbFromLocationText(`1 Test Street ${s.name} SA ${s.postcode} AUSTRALIA`) !== `${s.name} (${s.postcode})`);
    assert.deepEqual(wrong, []);
    const legacyWrong = suburbs.filter((s) => legacyMatchSuburbFromLocationText(`1 Test Street ${s.name} SA ${s.postcode} AUSTRALIA`) !== `${s.name} (${s.postcode})`);
    assert.ok(legacyWrong.length > 100, `today's matcher misses ${legacyWrong.length}`);
  } finally {
    server.close();
  }
});
