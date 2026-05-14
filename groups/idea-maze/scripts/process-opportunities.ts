/**
 * Auto-process scored opportunities after clustering.
 *
 * Buckets:
 * - 9-10: draft research and publish an artifact
 * - <9: skip and ignore it
 *
 * Usage: tsx process-opportunities.ts [--limit N] [--all]
 */

import { closeDb, getDb } from './lib/db.ts';
import { setOpportunityLifecycle } from './lib/opportunity-state.ts';
import {
  AUTO_PUBLISH_MIN_BUCKET,
  classifyOpportunityScore,
} from './lib/opportunity-policy.ts';
import { researchOpportunity } from './lib/research.ts';
import { publishResearchArtifact } from './lib/review.ts';
import { withStageRunContext } from './lib/run-events.ts';
import { initSchema } from './lib/schema.ts';

interface OpportunityRow {
  has_any_run: number;
  has_artifact: number;
  id: number;
  market_score: number;
  draft_run_id: number | null;
  final_score: number;
  slug: string;
  taste_adjustment: number;
  title: string;
}

const DEFAULT_NEW_RESEARCH_LIMIT = 3;

function parseNewResearchLimit(argv = process.argv): number {
  if (argv.includes('--all')) {
    return Number.POSITIVE_INFINITY;
  }

  const limitIndex = argv.indexOf('--limit');
  if (limitIndex === -1) {
    return DEFAULT_NEW_RESEARCH_LIMIT;
  }

  const parsed = Number(argv[limitIndex + 1]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('--limit must be a non-negative number.');
  }

  return Math.floor(parsed);
}

async function main() {
  const db = getDb();
  initSchema(db);
  const stageRun = withStageRunContext(db, 'process-opportunities', {
    requestedBy: process.env.IDEA_MAZE_PARENT_RUN_ID ? 'system' : 'user',
  });
  try {
    const maxNewResearchRuns = parseNewResearchLimit();
    const ignoredLowScoreOpportunities = (
      db
        .prepare(
          `
      SELECT COUNT(*) AS count
      FROM opportunities
      WHERE status = 'active'
        AND final_score < ?
    `,
        )
        .get(AUTO_PUBLISH_MIN_BUCKET) as { count: number }
    ).count;
    const opportunities = db
      .prepare(
        `
      SELECT
        o.id,
        o.slug,
        o.title,
        o.market_score,
        o.final_score,
        o.taste_adjustment,
        EXISTS(
          SELECT 1
          FROM runs r
          WHERE r.target_id = CAST(o.id AS TEXT)
            AND r.status != 'error'
        ) AS has_any_run,
        EXISTS(SELECT 1 FROM artifacts a WHERE a.opportunity_id = o.id) AS has_artifact,
	        (
	          SELECT r.id
	          FROM runs r
	          WHERE r.target_id = CAST(o.id AS TEXT) AND r.status IN ('draft_ready', 'review_gate')
	          ORDER BY r.id DESC
	          LIMIT 1
	        ) AS draft_run_id
      FROM opportunities o
      WHERE o.status = 'active'
        AND o.final_score >= ?
      ORDER BY o.final_score DESC, o.updated_at_utc DESC
    `,
      )
      .all(AUTO_PUBLISH_MIN_BUCKET) as OpportunityRow[];

    if (!opportunities.length) {
      console.log('No high-score artifact candidates to process.');
      if (ignoredLowScoreOpportunities > 0) {
        console.log(
          `Ignored ${ignoredLowScoreOpportunities} low-score active opportunities.`,
        );
      }
      stageRun.finish('completed', 'No opportunities to process.', {
        ignored: ignoredLowScoreOpportunities,
        processed_opportunities: ignoredLowScoreOpportunities,
      });
      return;
    }

    console.log(
      `Processing ${opportunities.length} high-score artifact candidates (new research budget: ${
        Number.isFinite(maxNewResearchRuns) ? maxNewResearchRuns : 'unbounded'
      }, ignored low-score active opportunities: ${ignoredLowScoreOpportunities}).`,
    );

    const summary = {
      published_existing: 0,
      published_new: 0,
      deferred_due_to_budget: 0,
      ignored: ignoredLowScoreOpportunities,
      skipped_existing: 0,
    };
    let startedNewResearchRuns = 0;

    for (const opp of opportunities) {
      const policy = classifyOpportunityScore(opp.final_score);

      if (policy.disposition === 'ignore') {
        summary.ignored++;
        continue;
      }

      setOpportunityLifecycle(db, opp.id, 'shortlisted', {
        payload: {
          final_score: opp.final_score,
          market_score: opp.market_score,
          automation_disposition: policy.disposition,
          score_bucket: policy.bucket,
          taste_adjustment: opp.taste_adjustment,
        },
        runId: stageRun.runId,
        summary: `Opportunity shortlisted at final score ${opp.final_score}.`,
      });

      if (opp.draft_run_id) {
        const { path } = publishResearchArtifact(
          db,
          Number(opp.draft_run_id),
          `Published by automated pipeline for score bucket ${policy.bucket}.`,
        );
        console.log(
          `Published existing research draft #${opp.draft_run_id} for ${opp.slug}: ${path}`,
        );
        summary.published_existing++;
        continue;
      }

      if (opp.has_any_run || opp.has_artifact) {
        console.log(
          `Skipping ${opp.slug}: existing research run/history already present.`,
        );
        summary.skipped_existing++;
        continue;
      }

      if (startedNewResearchRuns >= maxNewResearchRuns) {
        console.log(
          `Deferring ${opp.slug}: reached new research budget for this run.`,
        );
        summary.deferred_due_to_budget++;
        continue;
      }

      startedNewResearchRuns++;

      const result = await researchOpportunity(opp.slug, {
        db,
        logger: console,
        publicationNotes: `Published by automated pipeline for score bucket ${policy.bucket}.`,
        requestedBy: 'system',
        runIdForEvents: stageRun.runId,
      });

      if (!result.artifactPath) {
        throw new Error(`Expected artifact publication for ${opp.slug}.`);
      }
      summary.published_new++;
    }

    console.log('\nOpportunity processing summary:');
    console.log(
      `  published existing drafts:          ${summary.published_existing}`,
    );
    console.log(
      `  published new research artifacts:   ${summary.published_new}`,
    );
    console.log(
      `  skipped existing history:           ${summary.skipped_existing}`,
    );
    console.log(
      `  deferred due to per-run budget:     ${summary.deferred_due_to_budget}`,
    );
    console.log(`  ignored low-score opportunities:    ${summary.ignored}`);
    stageRun.finish('completed', 'Opportunity processing complete.', {
      ...summary,
      artifact_candidates: opportunities.length,
      processed_opportunities: opportunities.length + summary.ignored,
    });
  } catch (err) {
    stageRun.finish(
      'error',
      `Opportunity processing failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  } finally {
    closeDb();
  }
}

main().catch((err) => {
  console.error('Opportunity processing failed:', err);
  process.exit(1);
});
