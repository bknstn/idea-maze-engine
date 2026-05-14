/**
 * Raw file cleanup — deletes raw snapshot files past the retention window.
 *
 * Default retention: 30 days. Override with --days N.
 *
 * Usage: tsx cleanup-raw.ts [--days 30]
 */

import { readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { getDb, closeDb } from "./lib/db.ts";
import { initSchema } from "./lib/schema.ts";

const GROUP_DIR = process.env.WORKSPACE_GROUP ?? "/workspace/group";
const RAW_DIR = resolve(GROUP_DIR, "data", "raw");
const DEFAULT_RETENTION_DAYS = 30;

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(full);
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return files;
}

function tryRemoveEmptyDirs(dir: string, stopAt: string): void {
  if (dir === stopAt) return;
  try {
    const entries = readdirSync(dir);
    if (entries.length === 0) {
      rmdirSync(dir);
      tryRemoveEmptyDirs(resolve(dir, ".."), stopAt);
    }
  } catch {
    // Not empty or doesn't exist
  }
}

function main() {
  const daysArg = process.argv.indexOf("--days");
  const retentionDays = daysArg >= 0 ? Number(process.argv[daysArg + 1]) || DEFAULT_RETENTION_DAYS : DEFAULT_RETENTION_DAYS;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Ensure DB is initialized
  const db = getDb();
  initSchema(db);
  closeDb();

  const sources = ["gmail", "telegram", "reddit", "search"];
  let deleted = 0;
  let kept = 0;

  for (const source of sources) {
    const sourceDir = resolve(RAW_DIR, source);
    const files = walkFiles(sourceDir);

    for (const file of files) {
      try {
        const stat = statSync(file);
        if (stat.mtimeMs < cutoff) {
          unlinkSync(file);
          tryRemoveEmptyDirs(resolve(file, ".."), sourceDir);
          deleted++;
        } else {
          kept++;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  }

  console.log(`Cleanup complete. Deleted: ${deleted}, Kept: ${kept} (retention: ${retentionDays} days)`);
}

main();
