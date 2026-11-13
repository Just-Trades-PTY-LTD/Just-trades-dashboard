#!/usr/bin/env node
// Release check: does the CRM survive REAL-WORLD data before it goes live?
//
// Runs the built app (npm run crm:build first) in a real browser against a
// THROWAWAY copy of a full JSON backup, with a fake AroFlo that sends messy
// data the way the real one does (invoice numbers as numbers, nested values,
// numbers where text is expected). It then:
//   1. Opens every tab and sub-tab.
//   2. Fills and saves every Technician & Sales entry type and every Calls &
//      Contacts call type, entering real Job Numbers from the backup, waiting
//      for AroFlo to fill in, and pressing every "Use this" button.
//   3. Fails on any blank page / "Something went wrong" screen / browser
//      error, and on any saved Job or Invoice Number stored as a number or as
//      "2180.0".
// The live database and AroFlo are never touched: the copy lives in a temp
// folder and AroFlo is a local fake (GET-only).
//
// Usage (from the repo root):
//   npm run crm:build
//   NODE_PATH=$(npm root -g) node service-crm/scripts/release-check.cjs --backup /path/to/crm-backup.json
// Exit code 0 = pass, 1 = fail. Screenshots of any failure go to the temp folder.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const BACKUP = arg('--backup');
if (!BACKUP || !fs.existsSync(BACKUP)) {
  console.error('Usage: node service-crm/scripts/release-check.cjs --backup <full JSON backup>');
  process.exit(2);
}
if (!fs.existsSync(path.join(ROOT, 'client/dist/index.html'))) {
  console.error('No client build — run "npm run crm:build" first.');
  process.exit(2);
}

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-release-check-'));
const DB = path.join(WORK, 'copy.sqlite');
const PASSWORD = 'ReleaseCheck123!';
const EMAIL = 'release-check@test.local';
const STARTED = Date.now();
const results = [];
const failures = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}  [${Math.round((Date.now() - STARTED) / 1000)}s]`);
};

// ---- Messy fake AroFlo (any Job Number exists) -----------------------------
function startMessyAroflo() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Adelaide' });
  const later = new Date(Date.now() + 6 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Australia/Adelaide' });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (req.method !== 'GET') {
      res.writeHead(405);
      return res.end();
    }
    const p = u.pathname;
    if (p === '/v2/businessunits') return send({ items: [{ id: 'BU1' }] });
    if (p === '/v2/tasks') {
      const jn = Number(u.searchParams.get('jobNumber') || u.searchParams.get('where')?.match(/\d{3,}/)?.[0]);
      // Newest-first listing: a block of Job Numbers around the backup's.
      if (u.searchParams.get('page') !== '1') return send({ items: [] });
      const items = [];
      for (let n = 3500; n >= 1000; n--) items.push({ id: `T${n}`, jobNumber: n, client: { id: 'C1' } });
      return send({ items: Number.isFinite(jn) ? items.filter((t) => t.jobNumber === jn) : items });
    }
    const t = p.match(/^\/v2\/tasks\/T(\d+)$/);
    if (t) {
      const n = Number(t[1]);
      return send({
        id: `T${n}`,
        jobNumber: n, // a number, like the real AroFlo
        status: n % 2 ? 'PENDING' : 'COMPLETED',
        taskType: { name: 'Hot Water Unit' },
        description: `<p>Release check job ${n}</p>`,
        client: { id: 'C1' },
        locationText: 'Salisbury North SA 5108 AUSTRALIA',
        location: { suburb: 'Salisbury North', postCode: 5108, state: 'SA' },
        schedule: { scheduleDate: `${later}T00:00:00`, resources: [{ name: 'Release Tech' }] },
      });
    }
    if (p === '/v2/invoices') {
      const n = Number(String(u.searchParams.get('taskId') || '').replace(/\D/g, '')) || 1;
      // Invoice numbers as NUMBERS; one job in three has two invoices.
      const items = [{ id: n, invoiceNumber: 900000 + n, invoicedDateTime: `${today}T00:00:00`, totalAmountEx: 1234.5, status: 'APPROVED', type: 'FINAL_INVOICE' }];
      if (n % 3 === 0) items.push({ id: n + 1, invoiceNumber: 800000 + n, invoicedDateTime: `${today}T00:00:00`, totalAmountEx: '250.00', status: 'DRAFT', type: 'PART_INVOICE' });
      return send({ items });
    }
    if (/\/labours$/.test(p))
      return send({ items: [{ date: today, startTime: `${today}T08:00:00`, finishTime: `${today}T10:00:00`, hours: '2', user: { givenName: 'Release', familyName: 'Tech', position: { name: 'Electrician', id: 7 } } }] });
    if (p === '/v2/schedules') return send({ items: [{ startTime: `${later}T08:00:00`, endTime: `${later}T12:00:00`, hours: 4, resource: { givenName: 'Release', familyName: 'Tech', position: 3 } }] });
    if (p.startsWith('/v2/customfields/')) return send({ items: [{ name: 'Lead Source', value: 'Google' }] });
    return send({ items: [] });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

// ---- Throwaway copy of the backup ------------------------------------------
async function makeCopy() {
  if (!DB.startsWith(os.tmpdir())) throw new Error('refusing: copy must be in the temp folder');
  const { openDb } = await import(path.join(ROOT, 'server/src/db/index.js'));
  openDb(DB, { allowFreshInit: true });
  const { restoreFromBackup } = await import(path.join(ROOT, 'server/src/db/restore.js'));
  restoreFromBackup(JSON.parse(fs.readFileSync(BACKUP, 'utf8')));
  const { hashPassword } = await import(path.join(ROOT, 'server/src/lib/password.js'));
  const { run } = await import(path.join(ROOT, 'server/src/db/index.js'));
  run("INSERT INTO users (name, email, password_hash, role) VALUES ('Release Check', ?, ?, 'admin')", [EMAIL, await hashPassword(PASSWORD)]);
}

function query(sql) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(DB, { readOnly: true });
  try {
    return d.prepare(sql).all();
  } finally {
    d.close();
  }
}

function pickJobNumbers() {
  const one = (sql) => String(query(sql)[0]?.jn ?? '').trim();
  return {
    bookedNoJob: query(
      "SELECT DISTINCT TRIM(job_number) jn FROM calls WHERE archived=0 AND call_type='Lead' AND booked='Yes' AND TRIM(job_number)<>'' AND TRIM(job_number) NOT IN (SELECT TRIM(job_number) FROM jobs) ORDER BY id DESC LIMIT 3"
    ).map((r) => String(r.jn)),
    knockback: one("SELECT TRIM(job_number) jn FROM jobs WHERE archived=0 AND knockback=1 AND converted_later=0 AND TRIM(job_number)<>'' ORDER BY id DESC LIMIT 1"),
    sale: one("SELECT TRIM(job_number) jn FROM sales WHERE archived=0 AND is_upsell=0 AND TRIM(job_number)<>'' ORDER BY id DESC LIMIT 1"),
    saleInvoice: one("SELECT TRIM(invoice_number) jn FROM sales WHERE archived=0 AND is_upsell=0 AND TRIM(job_number)<>'' ORDER BY id DESC LIMIT 1"),
    job: one("SELECT TRIM(job_number) jn FROM jobs WHERE archived=0 AND TRIM(job_number)<>'' ORDER BY id DESC LIMIT 1"),
  };
}

const counts = () => {
  const r = query("SELECT (SELECT COUNT(*) FROM calls) c, (SELECT COUNT(*) FROM jobs) j, (SELECT COUNT(*) FROM sales) s, (SELECT COUNT(*) FROM call_backs) b, (SELECT COUNT(*) FROM pending_cancellations) p")[0];
  return r.c + r.j + r.s + r.b + r.p;
};

// ---- Browser ----------------------------------------------------------------
async function main() {
  console.log(`Release check — throwaway copy in ${WORK}`);
  await makeCopy();
  const before = { maxCall: query('SELECT COALESCE(MAX(id),0) m FROM calls')[0].m, maxSale: query('SELECT COALESCE(MAX(id),0) m FROM sales')[0].m, maxJob: query('SELECT COALESCE(MAX(id),0) m FROM jobs')[0].m, maxCb: query('SELECT COALESCE(MAX(id),0) m FROM call_backs')[0].m };
  const jns = pickJobNumbers();
  const aroflo = await startMessyAroflo();
  const port = 4400 + Math.floor(Math.random() * 500);
  const crm = spawn(process.execPath, ['server/src/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DB, PORT: String(port), AROFLO_PAT: 'release-check', AROFLO_BASE_URL: `http://localhost:${aroflo.address().port}/v2` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  crm.stdout.on('data', (d) => (serverLog += d));
  crm.stderr.on('data', (d) => (serverLog += d));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 1300 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.accept());
  // A step that can't complete fails quickly instead of hanging the check.
  page.setDefaultTimeout(15000);
  const base = `http://localhost:${port}/`;
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await page.goto(base);
        break;
      } catch {
        await page.waitForTimeout(250);
      }
    }
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    const screenBroken = async () => {
      if ((await page.locator('.app-shell').count()) === 0) return 'blank page';
      const errBox = page.getByTestId('screen-error');
      const err = (await errBox.count()) ? await errBox.first().innerText().catch(() => 'Something went wrong') : null;
      return err ? err.split('\n').slice(0, 3).join(' / ') : null;
    };
    const check = async (name) => {
      const broken = await screenBroken();
      const errs = pageErrors.splice(0);
      const ok = !broken && !errs.length;
      if (!ok) await page.screenshot({ path: path.join(WORK, `${name.replace(/\W+/g, '-')}.png`), fullPage: true });
      record(name, ok, broken || errs.join(' | '));
      if (broken) {
        await page.goto(base);
        await page.waitForTimeout(1200);
      }
      return ok;
    };
    const tab = (label) => page.locator('.app-tabs button').filter({ hasText: new RegExp(`^${label.replace(/[&]/g, '.')}$`) }).first();
    const field = (label) => page.locator('.field').filter({ has: page.locator(`label:text-is("${label}")`) }).first();

    // 1. Every tab and sub-tab (every group of sub-tabs on the page).
    const tabNames = await page.locator('.app-tabs button').allInnerTexts();
    for (const t of tabNames) {
      await tab(t).click();
      await page.waitForTimeout(700);
      let visited = 0;
      const groups = await page.locator('.subtabs').count();
      for (let g = 0; g < groups; g++) {
        const labels = await page.locator('.subtabs').nth(g).locator('button').allInnerTexts().catch(() => []);
        for (const s of labels) {
          const btn = page.locator('.subtabs').nth(g).locator('button').filter({ hasText: s }).first();
          if (!(await btn.count())) continue;
          await btn.click();
          await page.waitForTimeout(700);
          await check(`Screen: ${t} → ${s}`);
          visited++;
        }
      }
      if (!visited) await check(`Screen: ${t}`);
    }

    // Fill anything still required and blank, generically.
    async function fillRequired() {
      const fields = page.locator('form .field');
      const n = await fields.count();
      for (let i = 0; i < n; i++) {
        const f = fields.nth(i);
        const label = (await f.locator('label').first().innerText().catch(() => '')) || '';
        if (!label.includes('*')) continue;
        const sel = f.locator('select').first();
        if ((await sel.count()) && (await sel.isEnabled().catch(() => false)) && !(await sel.inputValue())) {
          const vals = await sel.evaluate((el) => [...el.options].map((o) => o.value).filter(Boolean));
          if (vals.length) await sel.selectOption(vals[0]);
          continue;
        }
        const inp = f.locator('input:not([type=checkbox]), textarea').first();
        if ((await inp.count()) && (await inp.isEditable().catch(() => false)) && !(await inp.inputValue())) {
          const type = await inp.getAttribute('type');
          await inp.fill(type === 'number' ? '100' : type === 'date' ? new Date().toISOString().slice(0, 10) : 'Release check');
        }
      }
    }
    async function useEverything() {
      for (const name of [/^Use this$/, /^Use /, /Show AroFlo visits and time/]) {
        const btns = page.locator('form button[type=button]').filter({ hasText: name });
        const n = await btns.count();
        for (let i = 0; i < n; i++) {
          await btns.nth(i).click().catch(() => {});
          await page.waitForTimeout(250);
        }
      }
    }
    // The Job Number box under a label (exact text, with or without " *").
    async function enterJn(label, jn) {
      const box = page.locator('form .field').filter({ has: page.locator('label', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}( \\*)?$`) }) }).first().locator('input').first();
      await box.fill(String(jn));
      await box.blur();
      await page.waitForTimeout(4500); // AroFlo + lookups
    }
    const fresh = (() => {
      let n = 3400;
      return () => String(n++);
    })();

    // 2. Technician & Sales — every entry type.
    // [entry type, name, [label, Job Number] pairs entered in order, separate-invoice Upsell?]
    const tsCases = [
      ['new_job_sale_made', 'New Job — Sale Made', [['Job number (JN)', jns.bookedNoJob[0]]]],
      ['new_job_no_sale', 'New Job — No Sale', [['Job number (JN)', jns.bookedNoJob[1] || jns.bookedNoJob[0]]]],
      ['quote_approved_later', 'Quote Approved Later', [['Original Job Number', jns.knockback], ['New Job Number', fresh()]]],
      ['existing_job_upsell', 'Upsell (existing invoice)', [['Job Number', jns.sale]]],
      ['existing_job_upsell', 'Upsell (separate invoice)', [['Job Number', jns.sale]], true],
      ['call_back', 'Call Back', [['Original Job Number', jns.job], ['New Callback Job Number', fresh()]]],
    ];
    for (const [kind, name, entries, separate] of tsCases) {
      const label = `Technician & Sales: ${name} (JN ${entries.map((e) => e[1] || 'none').join(' / ')})`;
      if (entries.some((e) => !e[1])) {
        record(label, true, 'skipped — no suitable Job Number in this backup');
        continue;
      }
      await tab('Technician & sales').click();
      await page.waitForTimeout(500);
      await page.locator('.subtabs button').filter({ hasText: 'Log an entry' }).first().click();
      await page.waitForTimeout(500);
      await field('Entry type *').locator('select').selectOption(kind);
      await page.waitForTimeout(400);
      for (const [l, jn] of entries) await enterJn(l, jn);
      if (kind === 'existing_job_upsell' && !separate) {
        // On the job's existing invoice: its real invoice number, as staff would enter it.
        const inv = page.locator('form .field').filter({ has: page.locator('label', { hasText: /^Invoice number( \*)?$/i }) }).first().locator('input').first();
        await inv.fill(jns.saleInvoice.replace(/\.0+$/, '')); // as staff type it (some older records hold "2227.0")
        await inv.blur();
        await page.waitForTimeout(1500);
      }
      if (separate) {
        await page.locator('form input[type=radio]').nth(1).check().catch(() => {});
        await page.waitForTimeout(300);
        await enterJn('Separate AroFlo Job Number', fresh());
      }
      if (!(await check(`${label} — after AroFlo fill`))) continue;
      await useEverything();
      if (!(await check(`${label} — after "Use this"`))) continue;
      await fillRequired();
      const n0 = counts();
      await page.getByRole('button', { name: /^Save entry$/ }).click();
      await page.waitForTimeout(2500);
      if (!(await check(`${label} — save`))) continue;
      const notice = (await page.locator('.notice').count()) ? (await page.locator('.notice').first().innerText().catch(() => '')).slice(0, 160) : '';
      record(`${label} — saved`, counts() > n0, counts() > n0 ? '' : `not saved: ${notice}`);
    }

    // 3. Calls & Contacts — every call type.
    const callCases = [
      ['Lead (booked)', { 'Call type *': 'Lead', 'Booked? *': 'Yes' }, fresh()],
      ['Call back', { 'Call type *': 'Call back' }, jns.job],
      ['New Job Cancellation', { 'Call type *': 'Cancellation', 'Cancellation type': 'New Job Cancellation' }, jns.bookedNoJob[0]],
      ['Pending Cancellation', { 'Call type *': 'Cancellation', 'Cancellation type': 'Pending Cancellation' }, jns.sale],
      ['Not lead', { 'Call type *': 'Not lead' }, ''],
    ];
    for (const [name, selects, jn] of callCases) {
      const label = `Calls & Contacts: ${name}${jn ? ` (JN ${jn})` : ''}`;
      await tab('Calls & Contacts').click();
      await page.waitForTimeout(500);
      await page.locator('.subtabs button').first().click();
      await page.waitForTimeout(500);
      const cancel = page.getByRole('button', { name: /Cancel edit/ });
      if (await cancel.count()) await cancel.first().click();
      for (const [l, v] of Object.entries(selects)) {
        await field(l).locator('select').selectOption(v).catch(() => {});
        await page.waitForTimeout(300);
      }
      if (jn) await enterJn('Job number (JN)', jn);
      if (!(await check(`${label} — after lookups`))) continue;
      await useEverything();
      if (!(await check(`${label} — after "Use this"`))) continue;
      await fillRequired();
      const n0 = counts();
      for (let i = 0; i < 30 && /Checking/.test(await page.locator('form button[type=submit]').innerText().catch(() => '')); i++) await page.waitForTimeout(1000);
      await page.locator('form button[type=submit]').first().click();
      await page.waitForTimeout(2500);
      if (!(await check(`${label} — save`))) continue;
      const notice = (await page.locator('.notice').count()) ? (await page.locator('.notice').first().innerText().catch(() => '')).slice(0, 160) : '';
      record(`${label} — saved`, counts() > n0, counts() > n0 ? '' : `not saved: ${notice}`);
    }

    // 4. What was saved: Job and Invoice Numbers stored as text, no "2180.0".
    const bad = query(
      `SELECT 'call' t, id, job_number v FROM calls WHERE id > ${before.maxCall} AND (typeof(job_number) <> 'text' OR job_number LIKE '%.0')
       UNION ALL SELECT 'job', id, job_number FROM jobs WHERE id > ${before.maxJob} AND (typeof(job_number) <> 'text' OR job_number LIKE '%.0')
       UNION ALL SELECT 'sale job', id, job_number FROM sales WHERE id > ${before.maxSale} AND (typeof(job_number) <> 'text' OR job_number LIKE '%.0')
       UNION ALL SELECT 'sale invoice', id, invoice_number FROM sales WHERE id > ${before.maxSale} AND (typeof(invoice_number) <> 'text' OR invoice_number LIKE '%.0')
       UNION ALL SELECT 'call back', id, job_number FROM call_backs WHERE id > ${before.maxCb} AND (typeof(job_number) <> 'text' OR job_number LIKE '%.0')`
    );
    record('Saved Job / Invoice Numbers are stored as text', bad.length === 0, bad.map((b) => `${b.t} #${b.id}: ${b.v}`).join(', '));
    const lookupErrors = serverLog.split('\n').filter((l) => /\[aroflo-lookup\]|\[client-error\]|Error:/.test(l));
    record('No server errors during the check', lookupErrors.length === 0, lookupErrors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    crm.kill();
    aroflo.close();
  }

  console.log(`\n${failures.length ? 'RELEASE CHECK FAILED' : 'RELEASE CHECK PASSED'} — ${results.filter((r) => r.ok).length}/${results.length} checks passed.`);
  if (failures.length) console.log(`Screenshots: ${WORK}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Release check could not run:', err);
  process.exit(1);
});
