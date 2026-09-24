import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';

export async function startTestServer() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-')), 'test.sqlite');
  const app = createApp({ dbPath, allowFreshInit: true });
  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api`;

  let cookie = '';
  async function request(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    // An unmatched route falls through to Express's own default handler,
    // which responds with plain HTML, not JSON (there's no catch-all JSON
    // 404 registered) — parsed defensively here instead of throwing, so a
    // test asserting "this route doesn't exist" gets a clean status/body
    // instead of a JSON.parse crash.
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }
    return { status: res.status, data };
  }

  async function login(email = config.seedAdmin.email, password = config.seedAdmin.password) {
    const res = await request('POST', '/auth/login', { email, password });
    if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.data)}`);
    return res.data.user;
  }

  async function rawGet(path) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buffer };
  }

  function close() {
    server.close();
  }

  // Lets a test hold onto one session's cookie while switching the shared
  // `request`/`login` helpers to another (e.g. an admin deactivating a
  // second account, then confirming that account's still-live session is
  // now rejected) — save the current cookie before switching, restore it
  // with setCookie to resume acting as that first session.
  function getCookie() {
    return cookie;
  }
  function setCookie(value) {
    cookie = value;
  }

  return { request, login, close, rawGet, dbPath, getCookie, setCookie };
}
