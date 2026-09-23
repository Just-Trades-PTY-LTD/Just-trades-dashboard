-- Just Trades Service CRM — schema
-- A technician visit is counted once (jobs), a sale is counted once (sales),
-- no matter how many calls/quotes/invoices touch that job number.
-- See HANDOVER.md §5 for the entity design this implements.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS technicians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS job_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (trade_id, name)
);

-- Every other editable "pick one" list in Settings lives here, keyed by category.
-- Categories: lead_source, not_booked_reason, new_job_cancellation_reason,
-- pending_job_cancellation_reason, knockback_reason, callback_reason,
-- pending_cancellation_reason.
CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suburbs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  postcode TEXT NOT NULL DEFAULT '',
  UNIQUE (name, postcode)
);

-- A phone interaction. Optional link to a Job by Job Number.
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archived INTEGER NOT NULL DEFAULT 0,
  call_at TEXT NOT NULL,
  direction TEXT NOT NULL,
  handled_by_user_id INTEGER REFERENCES users(id),
  call_type TEXT NOT NULL,
  trade_id INTEGER REFERENCES trades(id),
  job_type_id INTEGER REFERENCES job_types(id),
  lead_source_id INTEGER REFERENCES list_items(id),
  booked TEXT NOT NULL DEFAULT '',
  not_booked_reason_id INTEGER REFERENCES list_items(id),
  cancellation_type TEXT NOT NULL DEFAULT '',
  cancellation_reason_id INTEGER REFERENCES list_items(id),
  call_back_reason_id INTEGER REFERENCES list_items(id),
  job_number TEXT NOT NULL DEFAULT '',
  job_id INTEGER REFERENCES jobs(id),
  -- Set when call_type = 'Cancellation' and cancellation_type = 'Pending
  -- Cancellation': the pending_cancellations row this call created/maintains
  -- against the existing Technician & Sales record it links to by job
  -- number. Never creates a new job or sale of its own. ON DELETE SET NULL
  -- so removing that row (the call was edited away from Pending Cancellation,
  -- or deleted) never trips over this call's own reference to it.
  pending_cancellation_id INTEGER REFERENCES pending_cancellations(id) ON DELETE SET NULL,
  suburb TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  follow_up INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per technician visit. Created by "New Job — No Sale" or
-- "New Job — Sale Made". This is what "jobs attended" counts.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archived INTEGER NOT NULL DEFAULT 0,
  job_number TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  technician_id INTEGER REFERENCES technicians(id),
  trade_id INTEGER REFERENCES trades(id),
  job_type_id INTEGER REFERENCES job_types(id),
  lead TEXT NOT NULL DEFAULT '',
  inspection_sheet TEXT NOT NULL DEFAULT '',
  option_sheet TEXT NOT NULL DEFAULT '',
  had_sale_at_visit INTEGER NOT NULL DEFAULT 0,
  knockback INTEGER NOT NULL DEFAULT 0,
  knockback_reason_id INTEGER REFERENCES list_items(id),
  converted_later INTEGER NOT NULL DEFAULT 0,
  converted_by_sale_id INTEGER REFERENCES sales(id),
  work_completion TEXT NOT NULL DEFAULT '',
  install_technician_id INTEGER REFERENCES technicians(id),
  install_date TEXT NOT NULL DEFAULT '',
  comments TEXT NOT NULL DEFAULT '',
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A sale: either made at the same visit as the job, or a delayed quote
-- approval / extra invoice logged later against an existing job. A Job can
-- have zero, one or several Sales. Always ex GST, always by invoice date.
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archived INTEGER NOT NULL DEFAULT 0,
  job_id INTEGER REFERENCES jobs(id),
  job_number TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('sale_made_at_visit', 'quote_approved_later')),
  date_logged TEXT NOT NULL,
  credited_technician_id INTEGER REFERENCES technicians(id),
  trade_id INTEGER REFERENCES trades(id),
  job_type_id INTEGER REFERENCES job_types(id),
  invoice_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  sale_value_ex_gst REAL NOT NULL DEFAULT 0,
  comments TEXT NOT NULL DEFAULT '',
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A follow-up visit on a job that already exists, credited to the original
-- technician. Never a Job, never a Sale, never a Lead.
CREATE TABLE IF NOT EXISTS call_backs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archived INTEGER NOT NULL DEFAULT 0,
  job_id INTEGER REFERENCES jobs(id),
  job_number TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  attending_technician_id INTEGER REFERENCES technicians(id),
  credited_technician_id INTEGER REFERENCES technicians(id),
  trade_id INTEGER REFERENCES trades(id),
  job_type_id INTEGER REFERENCES job_types(id),
  reason_id INTEGER REFERENCES list_items(id),
  comments TEXT NOT NULL DEFAULT '',
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A marker against a Sale: it's being refunded/closed out while AroFlo
-- processes the close-out. Does not itself change the Sale's figures
-- (Just Trades decision: flag-only, matching the prototype — see HANDOVER §7.1).
CREATE TABLE IF NOT EXISTS pending_cancellations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archived INTEGER NOT NULL DEFAULT 0,
  sale_id INTEGER REFERENCES sales(id),
  job_number TEXT NOT NULL,
  date_logged TEXT NOT NULL,
  credited_technician_id INTEGER REFERENCES technicians(id),
  trade_id INTEGER REFERENCES trades(id),
  reason_id INTEGER REFERENCES list_items(id),
  comments TEXT NOT NULL DEFAULT '',
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Field-level change history, replacing the prototype's per-record _history
-- array. Now attributable to a real logged-in user (HANDOVER §7.2/§7.3).
-- One row per edit; changes_json holds {field: {from, to}} for every field
-- that changed in that save.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('call', 'job', 'sale', 'call_back', 'pending_cancellation')),
  entity_id INTEGER NOT NULL,
  changes_json TEXT NOT NULL,
  changed_by_user_id INTEGER REFERENCES users(id),
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-user layout preferences for the Reports page (each section's size and
-- collapsed state). Pure UI preference: never read by any report calculation
-- and never touches any CRM record. One row per (user, report); saving
-- upserts in place, so adding this table can't alter existing data.
CREATE TABLE IF NOT EXISTS user_report_layouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_key TEXT NOT NULL,
  layout_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, report_key)
);

CREATE INDEX IF NOT EXISTS idx_calls_job_number ON calls (job_number);
CREATE INDEX IF NOT EXISTS idx_jobs_job_number ON jobs (job_number);
CREATE INDEX IF NOT EXISTS idx_sales_job_number ON sales (job_number);
CREATE INDEX IF NOT EXISTS idx_sales_invoice_number ON sales (invoice_number);
CREATE INDEX IF NOT EXISTS idx_call_backs_job_number ON call_backs (job_number);
CREATE INDEX IF NOT EXISTS idx_pending_cancellations_job_number ON pending_cancellations (job_number);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);
