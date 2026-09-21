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

/** (Re)opens the database at the given path, applying the schema. Tests use
 * this to point the whole app at a fresh, isolated file per run. */
export function openDb(dbPath) {
  if (db) db.close();
  const foundExistingFile = fs.existsSync(dbPath);
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
