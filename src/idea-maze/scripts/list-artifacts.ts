import { getOption, hasFlag, writeJson } from './lib/cli.ts';
import { closeDb, getDb } from './lib/db.ts';
import {
  buildArtifactsReport,
  buildArtifactsSnapshot,
} from './lib/observability.ts';
import { initSchema } from './lib/schema.ts';

function parseLimit(): number {
  const raw = getOption('--limit') ?? '20';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
}

function main() {
  const db = getDb();
  initSchema(db);
  const limit = parseLimit();
  try {
    if (hasFlag('--json')) {
      writeJson(buildArtifactsSnapshot(db, limit));
      return;
    }
    process.stdout.write(buildArtifactsReport(db, limit));
  } finally {
    closeDb();
  }
}

main();
