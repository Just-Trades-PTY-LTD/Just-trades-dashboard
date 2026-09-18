# Just Trades — Service CRM

The real, working build of the Service CRM prototype, based on `HANDOVER.md`
and the published Claude.ai artifact. It sits alongside AroFlo (jobs,
customers, quotes, invoices) and Podium (phone calls) — it only stores the
extra context neither system captures: what a call was about, and what
actually happened on a technician's visit, linked back to AroFlo by Job
Number.

This is a separate app from `../server` / `../client` (the AroFlo
technician dashboard) — different purpose, own database, own login.

- `server/` — Node/Express API with a SQLite database (Node's built-in
  `node:sqlite`, no native dependency to compile).
- `client/` — React (Vite) frontend.

## Quick start

```bash
cp server/.env.example server/.env
npm run crm:dev
```

This starts the API on `http://localhost:4100` and the app on
`http://localhost:5273`. On first run the server seeds:

- The trades/job types, lead sources, and reason lists from the prototype.
- All ~1,930 SA suburbs from the supplied suburb list (with postcodes).
- One admin account — email and password from `server/.env`
  (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, defaults printed to the
  server log on first boot). Change the password after first login, and add
  the rest of the team from Settings → Staff accounts.

## What changed from the prototype, and why

The prototype (Claude.ai artifact) used a shared browser session with no
login and a free-text "Entered by" name for attribution. Per the answers
given before this build started:

- **Real per-user accounts.** Every staff member logs in; every change is
  attributed to a verified user, not a typed name. Two roles: `admin`
  (Settings, staff accounts, data export/restore) and `staff` (Calls,
  Technician & Sales, Reports).
- **Pending Cancellation stays flag-only.** A refund on an already-invoiced
  sale is tracked as a separate count and never reduces that technician's
  sale figures for the period — matching the prototype exactly.
- **Real foreign keys instead of JN string-matching everywhere.** The
  prototype matched Job Numbers by string comparison on every read. Here,
  Calls/Sales/Call Backs/Pending Cancellations resolve their Job Number to
  a real `job_id` at the point they're saved (matching the prototype's own
  §5.2 recommendation to retire the string-matching shortcut). The JN is
  still what staff type and see — the resolution is invisible.
- A normalized schema (`jobs`, `sales`, `call_backs`, `pending_cancellations`,
  `calls`) replaces the prototype's single flat `techEntries` array, so a
  job, a sale, a call back and a pending cancellation are genuinely separate
  records with their own audit trail — while the UI still presents them as
  one merged "Job history" list, exactly like the prototype.

Everything else — every field, every conditional show/hide rule, the
knock-back → converted-later flip, the duplicate-invoice-counted-once rule,
the Reports KPIs/charts, the Settings lists, CSV/JSON export — is a direct,
field-for-field port of the prototype (`service-crm.jsx`, recovered from the
published artifact and read in full before writing any server code).

## Data model (see `server/src/db/schema.sql`)

The core rule, from the handover: **a technician visit is counted once, a
sale is counted once**, no matter how many calls, quotes, or invoices touch
that Job Number.

- **Call** — a phone interaction. Optional link to a Job by JN.
- **Job** — one row per technician visit ("New Job — No Sale" / "New Job —
  Sale Made"). This is what "jobs attended" counts.
- **Sale** — created either with the visit ("New Job — Sale Made") or later
  ("Existing Job — Quote Approved Later", which is also how a second invoice
  gets added to a job that already had a sale). A Job can have zero, one, or
  several Sales. Always ex GST, always dated by invoice date.
- **Call Back** — a follow-up visit, credited to the original technician.
  Never a Job, never a Sale, never a Lead.
- **Pending Cancellation** — a marker against a Sale. Flag-only (see above).

When a "Quote Approved Later" Sale is saved against a JN that has an
un-converted knock-back Job, that Job flips to `converted_later = 1` in the
same transaction, with an audit log entry recording the change — this is
tested explicitly (see below).

## Tests

```bash
npm run crm:test
```

`server/tests/workedExample.test.js` is HANDOVER.md §6's worked example,
asserted exactly: one Job row, one Sale, the knock-back flips to converted,
and jobs-attended never double-counts, including that filtering to before
the approval reflects the job's live state (not a historical snapshot) —
matching the in-app disclaimer that re-running a report can show different
numbers than when it was first generated.

`server/tests/doubleCounting.test.js` covers: duplicate invoice numbers
counted once (keeping the most recent), Call Backs never counting as a job/
lead/sale, and Pending Cancellations never touching sale figures.

## Still open (see original HANDOVER.md §7 for full context)

- **§7.4 naming clarity** ("Pending job cancellation" on Calls vs. "Pending
  Cancellation" on Technician & Sales) — kept as named in the prototype;
  revisit if staff find it confusing in practice.
- **§7.5 bonus calculation** — out of scope by design. The CRM reports the
  ex-GST figures a bonus formula would need, but applies no formula itself.
