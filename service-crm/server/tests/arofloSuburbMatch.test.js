import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { run as dbRun } from '../src/db/index.js';
import { matchSuburbFromLocationText } from '../src/aroflo/suburbMatch.js';

// AroFlo never carries a structured suburb (location is always null in every
// real test) — this matches the free-text locationText against the CRM's
// own suburb list by postcode first (unambiguous), then by which candidate
// name actually appears in the text. Only a single, confident match is ever
// returned. Uses a dedicated, unlikely-to-collide postcode (9999) so this
// never depends on (or conflicts with) the real seeded SA suburb list.

test('a single confident match: one suburb shares the postcode and its name appears in the text', async () => {
  const server = await startTestServer();
  try {
    dbRun("INSERT INTO suburbs (name, postcode) VALUES ('Testville', '9999')");
    const result = matchSuburbFromLocationText('12 Example Street Testville SA 9999 AUSTRALIA');
    assert.equal(result, 'Testville (9999)');
  } finally {
    server.close();
  }
});

test('no postcode found in the text at all: returns null, never guesses', async () => {
  const server = await startTestServer();
  try {
    const result = matchSuburbFromLocationText('12 Example Street Testville, no state or postcode here');
    assert.equal(result, null);
  } finally {
    server.close();
  }
});

test('postcode found but no suburb in this CRM shares it: returns null', async () => {
  const server = await startTestServer();
  try {
    const result = matchSuburbFromLocationText('12 Example Street Nowhereville SA 9988 AUSTRALIA');
    assert.equal(result, null);
  } finally {
    server.close();
  }
});

test('postcode shared by multiple suburbs, but only one of their names appears in the text: still a confident match', async () => {
  const server = await startTestServer();
  try {
    dbRun("INSERT INTO suburbs (name, postcode) VALUES ('Alpha Park', '9997')");
    dbRun("INSERT INTO suburbs (name, postcode) VALUES ('Beta Gardens', '9997')");
    const result = matchSuburbFromLocationText('5 Example Road Alpha Park SA 9997 AUSTRALIA');
    assert.equal(result, 'Alpha Park (9997)');
  } finally {
    server.close();
  }
});

test('postcode shared by multiple suburbs and more than one name appears (ambiguous): returns null rather than guessing', async () => {
  const server = await startTestServer();
  try {
    dbRun("INSERT INTO suburbs (name, postcode) VALUES ('Gamma', '9996')");
    dbRun("INSERT INTO suburbs (name, postcode) VALUES ('Delta', '9996')");
    // A contrived address where both candidate names happen to appear.
    const result = matchSuburbFromLocationText('1 Gamma Delta Lane SA 9996 AUSTRALIA');
    assert.equal(result, null);
  } finally {
    server.close();
  }
});

test('a multi-word suburb name is matched correctly, not broken by word-position splitting', async () => {
  const server = await startTestServer();
  try {
    dbRun("INSERT INTO suburbs (name, postcode) VALUES ('Windsor Gardens', '9995')");
    const result = matchSuburbFromLocationText('40 Johnson Parade Windsor Gardens SA 9995 AUSTRALIA');
    assert.equal(result, 'Windsor Gardens (9995)');
  } finally {
    server.close();
  }
});

test('blank/missing locationText returns null without throwing', async () => {
  const server = await startTestServer();
  try {
    assert.equal(matchSuburbFromLocationText(''), null);
    assert.equal(matchSuburbFromLocationText(null), null);
    assert.equal(matchSuburbFromLocationText(undefined), null);
  } finally {
    server.close();
  }
});
