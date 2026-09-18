import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, prepare, run, transaction } from './index.js';
import { hashPassword } from '../lib/password.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SA_SUBURBS = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data', 'sa-suburbs.json'), 'utf8'));

// Mirrors the prototype's DEFAULT_SETTINGS (service-crm.jsx) so a fresh
// install starts with the same categories Just Trades already tested.
const DEFAULT_TRADES_WITH_JOB_TYPES = {
  Plumbing: ['Hot water unit', 'Blocked drain', 'Leak', 'Gas fitting', 'Other'],
  Electrical: ['Switchboard', 'Lighting', 'Power point', 'Safety switch', 'Other'],
  'Heating & Cooling': ['Split system', 'Ducted system', 'Servicing', 'Repair', 'Other'],
};

const DEFAULT_LISTS = {
  lead_source: ['Google search', 'Google ads', 'Facebook / Instagram', 'Referral', 'Repeat customer', 'Signage / vehicle', 'Website enquiry', 'Other'],
  not_booked_reason: ['Price', 'Timing / availability', 'Chose another provider', 'Just gathering quotes', 'Outside service area', 'Lost contact / no response', 'Other'],
  new_job_cancellation_reason: ['Changed mind', 'Price', 'Found alternative provider', 'Timing no longer suitable', 'Other'],
  pending_job_cancellation_reason: ['Rescheduling', 'Price', 'No longer needed', 'Customer unresponsive', 'Other'],
  knockback_reason: ['Price', 'Wanted to compare quotes', 'Wants to think it over', 'Not the decision maker', 'Other'],
  callback_reason: ['Warranty issue', 'Customer reports a fault', 'Follow-up on workmanship', 'Parts replacement', 'Other'],
  pending_cancellation_reason: ['Customer changed mind after sale', 'Dispute over work', 'Could not honour price', 'Duplicate / error', 'Other'],
};

function seedTradesAndJobTypes() {
  const existing = get('SELECT COUNT(*) AS n FROM trades');
  if (existing.n > 0) return;
  transaction(() => {
    let tradeOrder = 0;
    for (const [trade, jobTypes] of Object.entries(DEFAULT_TRADES_WITH_JOB_TYPES)) {
      const { lastInsertRowid: tradeId } = run('INSERT INTO trades (name, sort_order) VALUES (?, ?)', [trade, tradeOrder++]);
      jobTypes.forEach((jt, i) => {
        run('INSERT INTO job_types (trade_id, name, sort_order) VALUES (?, ?, ?)', [tradeId, jt, i]);
      });
    }
  });
}

function seedLists() {
  const existing = get('SELECT COUNT(*) AS n FROM list_items');
  if (existing.n > 0) return;
  transaction(() => {
    for (const [category, items] of Object.entries(DEFAULT_LISTS)) {
      items.forEach((name, i) => {
        run('INSERT INTO list_items (category, name, sort_order) VALUES (?, ?, ?)', [category, name, i]);
      });
    }
  });
}

function seedSuburbs() {
  const existing = get('SELECT COUNT(*) AS n FROM suburbs');
  if (existing.n > 0) return;
  transaction(() => {
    const insert = prepare('INSERT OR IGNORE INTO suburbs (name, postcode) VALUES (?, ?)');
    for (const { name, postcode } of SA_SUBURBS) insert.run(name, postcode);
  });
}

function seedTechnicians() {
  const existing = get('SELECT COUNT(*) AS n FROM technicians');
  if (existing.n > 0) return;
  run('INSERT INTO technicians (name, sort_order) VALUES (?, ?)', ['Unassigned', 0]);
}

function seedAdmin() {
  const existing = get('SELECT COUNT(*) AS n FROM users');
  if (existing.n > 0) return;
  const { name, email, password } = config.seedAdmin;
  run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [
    name,
    email,
    hashPassword(password),
    'admin',
  ]);
  // eslint-disable-next-line no-console
  console.log(`Seeded initial admin account: ${email} — change the password after first login.`);
}

export function seedDatabase() {
  seedTradesAndJobTypes();
  seedLists();
  seedSuburbs();
  seedTechnicians();
  seedAdmin();
}
