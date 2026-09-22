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
    const data = text ? JSON.parse(text) : null;
    return { status: res.status, data };
  }

  async function login(email = config.seedAdmin.email, password = config.seedAdmin.password) {
    const res = await request('POST', '/auth/login', { email, password });
    if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.data)}`);
    return res.data.user;
  }

  function close() {
    server.close();
  }

  return { request, login, close, dbPath };
}
