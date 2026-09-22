import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb, DatabaseMissingError } from './db/index.js';
import { seedDatabase } from './db/seed.js';
import { writeAutomaticBackup } from './db/backup.js';
import { attachUser } from './middleware/auth.js';
import { createAuthRouter } from './routes/auth.js';
import { createUsersRouter } from './routes/users.js';
import { createSettingsRouter } from './routes/settings.js';
import { createCallsRouter, listCalls } from './routes/calls.js';
import { createTechSalesRouter, listTechEntries } from './routes/techSales.js';
import { createLookupRouter } from './routes/lookup.js';
import { createExportRouter } from './routes/export.js';
import { createReportsRouter } from './routes/reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = path.resolve(__dirname, '../../client/dist');

const AUTOMATIC_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A minimal app that answers every request with a clear, human-readable
 * warning instead of the real CRM — used only when openDb() refuses to start
 * because it can't find the database and hasn't been told a fresh one is
 * expected. Better than crash-looping: the site still responds, so Jade/Kurt
 * see an explicit explanation in the browser instead of a generic host error,
 * and nothing about their data has been touched. */
function createDatabaseMissingApp(detail) {
  const app = express();
  app.use((req, res) => {
    res
      .status(503)
      .type('html')
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Just Trades CRM — storage problem</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; line-height: 1.5; color: #222;">
  <h1 style="color: #a3323a;">Database not found</h1>
  <p>The CRM can't find its saved database, so it has stopped itself instead of starting a new, empty one.</p>
  <p><strong>Nothing has been deleted or changed.</strong> This almost always means the storage this app depends
  on isn't connected properly right now.</p>
  <p><strong>Please contact whoever manages hosting for this CRM before doing anything else.</strong> Do not
  re-enter data into a fresh copy — that would create a second, conflicting set of records once this is fixed.</p>
  <p style="color: #888; font-size: 12px; margin-top: 32px;">${detail}</p>
</body></html>`
      );
  });
  return app;
}

export function createApp({ dbPath, allowFreshInit } = {}) {
  const resolvedDbPath = dbPath || config.dbPath;
  const resolvedAllowFreshInit =
    allowFreshInit ?? (process.env.ALLOW_FRESH_DB_INIT === 'true' || process.env.NODE_ENV !== 'production');

  try {
    openDb(resolvedDbPath, { allowFreshInit: resolvedAllowFreshInit });
  } catch (err) {
    if (!(err instanceof DatabaseMissingError)) throw err;
    // eslint-disable-next-line no-console
    console.error('='.repeat(72));
    // eslint-disable-next-line no-console
    console.error('[FATAL] Refusing to start normally — database file not found.');
    // eslint-disable-next-line no-console
    console.error(err.message);
    // eslint-disable-next-line no-console
    console.error('='.repeat(72));
    return createDatabaseMissingApp(err.message);
  }

  seedDatabase();

  // A snapshot right after boot, then on a fixed interval — lives alongside
  // the live database (see db/backup.js), so this guards against
  // application-level mistakes (a bad edit, an accidental restore/clear), not
  // against the volume itself disappearing. A failure here is logged but
  // never allowed to take the running app down with it.
  function runAutomaticBackup() {
    try {
      writeAutomaticBackup(resolvedDbPath);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[backup] automatic backup failed:', err.message);
    }
  }
  runAutomaticBackup();
  // unref() so this timer never keeps the process (or a test run) alive on
  // its own — the app's actual HTTP listener does that.
  setInterval(runAutomaticBackup, AUTOMATIC_BACKUP_INTERVAL_MS).unref();

  const app = express();
  // Railway (and most PaaS hosts) terminate TLS in front of the app and
  // proxy over plain HTTP — this makes req.secure / the login cookie's
  // `secure` flag reflect the original HTTPS request instead of the
  // internal HTTP hop.
  app.set('trust proxy', 1);
  app.use(cors({ origin: config.clientOrigin, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(attachUser);

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', createAuthRouter());
  app.use('/api/users', createUsersRouter());
  app.use('/api/settings', createSettingsRouter());
  app.use('/api/calls', createCallsRouter());
  app.use('/api/tech', createTechSalesRouter());
  app.use('/api/lookup', createLookupRouter());
  app.use('/api/export', createExportRouter({ getCallRows: listCalls, getTechEntryRows: listTechEntries }));
  app.use('/api/reports', createReportsRouter());

  // In production this one server serves the built React app too, so the
  // trial site is a single deployable service. In local dev, client/dist
  // doesn't exist — Vite's own dev server (with its /api proxy) handles the
  // frontend instead, so this block does nothing.
  if (fs.existsSync(CLIENT_DIST)) {
    app.use(express.static(CLIENT_DIST));
    app.get(/^(?!\/api).*/, (req, res) => {
      res.sendFile(path.join(CLIENT_DIST, 'index.html'));
    });
  }

  return app;
}
