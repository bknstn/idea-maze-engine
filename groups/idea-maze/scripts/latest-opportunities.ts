import { getOption, hasFlag, writeJson } from './lib/cli.ts';
import { closeDb, getDb } from './lib/db.ts';
import { buildLatestReport, buildLatestSnapshot } from './lib/observability.ts';
import { initSchema } from './lib/schema.ts';

function parseLimit(): number {
  const raw = getOption('--limit') ?? '10';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function main() {
  const db = getDb();
  initSchema(db);
  const limit = parseLimit();
  try {
    if (hasFlag('--json')) {
      writeJson(buildLatestSnapshot(db, limit));
      return;
    }
    process.stdout.write(buildLatestReport(db, limit));
  } finally {
    closeDb();
  }
}

main();
