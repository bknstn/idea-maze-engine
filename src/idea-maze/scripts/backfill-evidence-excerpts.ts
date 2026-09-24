import { closeDb, getDb } from './lib/db.ts';
import { backfillEvidenceExcerpts } from './lib/evidence-excerpt-backfill.ts';
import { initSchema } from './lib/schema.ts';

function parseArgs(args: string[]): { apply: boolean; limit: number } {
  let apply = false;
  let limit = 100;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply') {
      apply = true;
    } else if (args[index] === '--limit') {
      const parsed = Number(args[index + 1]);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error('--limit must be a non-negative safe integer.');
      }
      limit = parsed;
      index++;
    } else if (args[index] === '--help' || args[index] === '-h') {
      console.log('Usage: npm run idea:backfill-evidence-excerpts -- [--apply] [--limit N]');
      console.log('Default is a 100-row dry run. This command uses exact legacy metadata matches only and makes no LLM calls.');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  return { apply, limit };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const db = getDb();
  try {
    initSchema(db);
    const result = backfillEvidenceExcerpts(db, options);
    console.log(`${result.dryRun ? 'Dry run' : 'Applied'} legacy evidence excerpt backfill.`);
    console.log(`Rows scanned: ${result.rowsScanned}; rows needing backfill: ${result.rowsNeedingBackfill}; malformed/non-object metadata skipped: ${result.rowsSkippedMalformed}.`);
    console.log(`Exact excerpts found: ${result.excerptsCreated}; candidate strings rejected: ${result.excerptsRejected}; rows updated: ${result.rowsUpdated}.`);
    if (result.dryRun) console.log('Pass --apply to write these metadata updates. No LLM calls are made.');
  } finally {
    closeDb();
  }
}

try {
  main();
} catch (error) {
  console.error(`Evidence excerpt backfill failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
