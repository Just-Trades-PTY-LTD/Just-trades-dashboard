import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
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

export function createApp({ dbPath } = {}) {
  openDb(dbPath || config.dbPath);
  seedDatabase();

  const app = express();
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

  return app;
}
