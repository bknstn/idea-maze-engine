import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const GROUP_DIR =
  process.env.WORKSPACE_GROUP ?? resolve(import.meta.dirname, '..', '..');
const DB_PATH = resolve(GROUP_DIR, 'data', 'lab.db');

let instance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (instance) return instance;
  instance = new Database(DB_PATH);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('busy_timeout = 5000');
  return instance;
}

export function closeDb(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
