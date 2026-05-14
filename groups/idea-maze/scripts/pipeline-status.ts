import { closeDb, getDb } from './lib/db.ts';
import {
  buildPipelineStatusReport,
  buildPipelineStatusSnapshot,
} from './lib/observability.ts';
import { initSchema } from './lib/schema.ts';
import { hasFlag, writeJson } from './lib/cli.ts';

function main() {
  const db = getDb();
  initSchema(db);
  try {
    if (hasFlag('--json')) {
      writeJson(buildPipelineStatusSnapshot(db));
    } else {
      process.stdout.write(buildPipelineStatusReport(db));
    }
  } finally {
    closeDb();
  }
}

main();
