import { getDb, closeDb } from './lib/db.ts';
import { applyHumanReviewDecision } from './lib/human-review.ts';
import { humanReviewUsage, parseHumanReviewArgs } from './lib/human-review-cli.ts';
import { initSchema } from './lib/schema.ts';
import { writeJson } from './lib/cli.ts';

function main() {
  const parsed = parseHumanReviewArgs(process.argv.slice(2));
  const db = getDb();
  try {
    initSchema(db);
    const result = applyHumanReviewDecision(db, {
      decision: parsed.decision,
      notes: parsed.notes,
      reasons: parsed.reasons,
      runId: parsed.runId,
    });

    if (parsed.json) writeJson(result);
    else {
      console.log(
        `Applied ${result.decision} review to ${result.slug} (run #${result.runId}).`,
      );
      if (result.convertedPublishedFeedback > 0) {
        console.log(
          `Converted ${result.convertedPublishedFeedback} published feedback feature(s) to ignored.`,
        );
      }
    }
  } finally {
    closeDb();
  }
}

try {
  main();
} catch (err) {
  console.error(humanReviewUsage());
  console.error('Review apply failed:', err);
  process.exit(1);
}
