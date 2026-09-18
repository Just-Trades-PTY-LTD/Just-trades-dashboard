import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { seedDatabase } from './db/seed.js';
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

export function createApp({ dbPath } = {}) {
  openDb(dbPath || config.dbPath);
  seedDatabase();

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
