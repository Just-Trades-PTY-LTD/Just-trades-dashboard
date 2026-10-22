import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');

export const config = {
  port: Number(process.env.PORT) || 4100,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5273',
  dbPath: path.resolve(serverRoot, process.env.DB_PATH || './data/crm.sqlite'),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  sessionDays: Number(process.env.SESSION_DAYS) || 30,
  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'Admin',
    email: (process.env.SEED_ADMIN_EMAIL || 'admin@justtrades.au').toLowerCase(),
    password: process.env.SEED_ADMIN_PASSWORD || 'change-me-on-first-login',
  },
  // Stage 1 AroFlo test lookup only — read-only, admin-only. Unset means the
  // feature reports itself as "not configured" rather than failing oddly.
  aroflo: {
    apiToken: process.env.AROFLO_PAT || '',
    baseUrl: process.env.AROFLO_BASE_URL || 'https://api.aroflo.com/v2',
  },
};
