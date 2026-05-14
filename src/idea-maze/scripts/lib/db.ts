import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { DB_PATH } from './paths.ts';

let instance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (instance) return instance;
  mkdirSync(dirname(DB_PATH), { recursive: true });
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
