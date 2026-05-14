/**
 * Initialize the Idea Maze database and directory structure.
 * Safe to re-run — all operations are idempotent.
 *
 * Usage: tsx init-db.ts
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, closeDb } from "./lib/db.ts";
import { initSchema } from "./lib/schema.ts";

const GROUP_DIR = process.env.WORKSPACE_GROUP ?? "/workspace/group";

// Ensure data directories exist
const dirs = [
  "data",
  "data/raw/gmail",
  "data/raw/telegram",
  "data/raw/reddit",
  "data/raw/search",
  "data/artifacts",
];

for (const dir of dirs) {
  mkdirSync(resolve(GROUP_DIR, dir), { recursive: true });
}

// Initialize database
const db = getDb();
initSchema(db);

// Print summary
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as { name: string }[];

console.log(`Initialized lab.db with ${tables.length} tables:`);
for (const { name } of tables) {
  const count = (db.prepare(`SELECT COUNT(*) as n FROM "${name}"`).get() as any).n;
  console.log(`  ${name}: ${count} rows`);
}

closeDb();
console.log("\nDone.");
