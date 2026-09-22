import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const schemaPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

let db;

// schema.sql only ever CREATEs tables that don't exist yet, so it can't add
// a column to a table that's already live on a deployed database. Each
// migration here is an idempotent, additive check that runs after schema.sql
// on every boot — safe to run against a brand-new DB (schema.sql already has
// the column, so these no-op) or an existing one (adds just what's missing).
// Never rewrite or remove an existing migration once it has shipped; add a
// new one instead, so a redeploy never loses data.
const MIGRATIONS = [
  {
    id: 'calls_pending_cancellation_id',
    run(database) {
      const hasColumn = database
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((c) => c.name === 'pending_cancellation_id');
      if (!hasColumn) {
        database.exec(
          'ALTER TABLE calls ADD COLUMN pending_cancellation_id INTEGER REFERENCES pending_cancellations(id) ON DELETE SET NULL'
        );
      }
    },
  },
  {
    // "New job cancellation" kept its meaning, just its exact label changed
    // — rename existing rows so they still match the current dropdown.
    // "Pending job cancellation" is NOT renamed here: it described a
    // different scenario (pre-visit) than the new "Pending Cancellation"
    // (post-sale), so remapping it would misclassify real historical data.
    id: 'rename_new_job_cancellation_label',
    run(database) {
      database
        .prepare("UPDATE calls SET cancellation_type = 'New Job Cancellation' WHERE cancellation_type = 'New job cancellation'")
        .run();
    },
  },
];

function runMigrations(database) {
  for (const migration of MIGRATIONS) migration.run(database);
}

/** Thrown when no database file exists at the configured path and creating a
 * fresh one hasn't been explicitly allowed — see openDb() below. */
export class DatabaseMissingError extends Error {}

/** (Re)opens the database at the given path, applying the schema.
 *
 * By default this REFUSES to create a brand-new database when none exists at
 * `dbPath` — pass `allowFreshInit: true` only for a genuine first-ever setup
 * (tests do this for every run, since each gets its own throwaway file). This
 * is deliberate: silently creating an empty database is exactly what turned a
 * storage/volume problem into total data loss before. Missing file + not
 * allowed => throw, so the caller can stop and warn instead of proceeding. */
export function openDb(dbPath, { allowFreshInit = false } = {}) {
  const foundExistingFile = fs.existsSync(dbPath);
  if (!foundExistingFile && !allowFreshInit) {
    // Deliberately don't touch the existing `db` handle (if any) here — this
    // is a refusal to proceed, not a switch to a new database, so whatever
    // was already open should stay open and usable.
    //
    // Also report what the *parent* directory looks like — this is the
    // difference between "the mount point doesn't exist at all" (nothing is
    // being mounted there) and "it exists but is empty" (something mounted a
    // blank volume in its place), which matters a great deal when this turns
    // into a hosting-provider support ticket.
    const parentDir = path.dirname(dbPath);
    let parentDetail;
    try {
      const parentExists = fs.existsSync(parentDir);
      parentDetail = parentExists
        ? `${parentDir} exists and contains: ${JSON.stringify(fs.readdirSync(parentDir))}`
        : `${parentDir} does not exist at all.`;
    } catch (err) {
      parentDetail = `could not inspect ${parentDir}: ${err.message}`;
    }
    throw new DatabaseMissingError(
      `No database file found at ${dbPath}, and creating a new one automatically is disabled. ` +
        `${parentDetail} ` +
        `If this is a genuine first-time setup, set ALLOW_FRESH_DB_INIT=true once, redeploy, then unset it. ` +
        `If this location previously held real data, this means the storage it lives on isn't being found — ` +
        `do not proceed without checking that first.`
    );
  }
  if (db) db.close();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // Prints on every boot so a deploy's logs show, unambiguously, whether the
  // database path actually resolved onto persistent storage: a fresh install
  // says "creating new file" once; any other boot claiming that is a red
  // flag that the volume isn't being reached (wrong path, wrong environment,
  // or a quoted/malformed DB_PATH value swallowing the leading '/').
  // eslint-disable-next-line no-console
  console.log(`[db] opening ${dbPath} (${foundExistingFile ? 'existing file found' : 'no existing file — creating new database'})`);
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schemaSql);
  runMigrations(db);
  return db;
}

export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

export function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function prepare(sql) {
  return db.prepare(sql);
}
