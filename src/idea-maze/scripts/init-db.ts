/**
 * Initialize the Idea Maze database and directory structure.
 * Safe to re-run — all operations are idempotent.
 *
 * Usage: tsx init-db.ts
 */

import { mkdirSync } from "node:fs";
import { getDb, closeDb } from "./lib/db.ts";
import { DATA_DIR } from "./lib/paths.ts";
import { initSchema } from "./lib/schema.ts";

// Ensure data directories exist
const dirs = [
  DATA_DIR,
  `${DATA_DIR}/raw/gmail`,
  `${DATA_DIR}/raw/telegram`,
  `${DATA_DIR}/raw/reddit`,
  `${DATA_DIR}/raw/search`,
  `${DATA_DIR}/artifacts`,
];

for (const dir of dirs) {
  mkdirSync(dir, { recursive: true });
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
