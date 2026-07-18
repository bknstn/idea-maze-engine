import { closeDb, getDb } from './lib/db.ts';
import { revalidateReviewGate } from './lib/review-gate-revalidation.ts';
import { initSchema } from './lib/schema.ts';

async function main() {
  const apply = process.argv.includes('--apply');
  const db = getDb();
  try {
    if (apply) initSchema(db);
    const evaluations = await revalidateReviewGate(db, { apply });
    const report = { applied: apply, candidates: evaluations, changed: apply ? evaluations.filter((item) => item.disposition !== 'review_eligible').length : 0 };
    console.log(JSON.stringify(report, null, process.argv.includes('--json') ? 2 : 2));
  } finally { closeDb(); }
}
main().catch((error) => { console.error(error); process.exitCode=1; });
