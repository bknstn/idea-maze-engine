import { closeDb, getDb } from './lib/db.ts';
import {
  buildOpportunityExplanation,
  buildOpportunityExplanationSnapshot,
} from './lib/observability.ts';
import { initSchema } from './lib/schema.ts';
import { getOption, getPositional, hasFlag, writeJson } from './lib/cli.ts';

function main() {
  const slug = getOption('--id') ?? getOption('--slug') ?? getPositional(0);
  if (!slug) {
    console.error('Usage: tsx explain-opportunity.ts <slug>');
    process.exit(1);
  }

  const db = getDb();
  initSchema(db);
  try {
    if (hasFlag('--json')) {
      writeJson(buildOpportunityExplanationSnapshot(db, slug));
    } else {
      process.stdout.write(buildOpportunityExplanation(db, slug));
    }
  } finally {
    closeDb();
  }
}

main();
