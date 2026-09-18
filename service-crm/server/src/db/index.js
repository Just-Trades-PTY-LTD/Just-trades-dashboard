import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const schemaPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');

let db;

/** (Re)opens the database at the given path, applying the schema. Tests use
 * this to point the whole app at a fresh, isolated file per run. */
export function openDb(dbPath) {
  if (db) db.close();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schemaSql);
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
