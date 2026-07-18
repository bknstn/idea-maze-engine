/**
 * Auto-process scored opportunities after clustering.
 *
 * Buckets:
 * - 9-10: draft research and leave it at the review gate
 * - <9: skip and ignore it
 *
 * Usage: tsx process-opportunities.ts [--limit N] [--all]
 */

import { closeDb, getDb } from './lib/db.ts';
import { attachDuplicateEvidence } from './lib/duplicate-opportunities.ts';
import { setOpportunityLifecycle } from './lib/opportunity-state.ts';
import {
  AUTO_PUBLISH_MIN_BUCKET,
  classifyOpportunityForAutomation,
} from './lib/opportunity-policy.ts';
import { researchOpportunity } from './lib/research.ts';
import { evaluateReviewGateCandidate } from './lib/review-gate-revalidation.ts';
import { withStageRunContext } from './lib/run-events.ts';
import { initSchema } from './lib/schema.ts';

interface OpportunityRow {
  cluster_key: string;
  has_any_run: number;
  has_artifact: number;
  id: number;
  market_score: number;
  draft_run_id: number | null;
  final_score: number;
  slug: string;
  taste_adjustment: number;
  thesis: string;
  title: string;
}

const DEFAULT_NEW_RESEARCH_LIMIT = 3;

function isQualityGateDisabled(): boolean {
  return process.env.IDEA_MAZE_DISABLE_QUALITY_GATE === '1';
}

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
        AND lifecycle_stage NOT IN ('approved', 'rejected')
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
        o.thesis,
        o.cluster_key,
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
        AND o.lifecycle_stage NOT IN ('approved', 'rejected')
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
      review_gate_existing: 0,
      review_gate_new: 0,
      deferred_due_to_budget: 0,
      ignored: ignoredLowScoreOpportunities,
      needs_more_evidence: 0,
      promo_filtered: 0,
      quality_gate_archived: 0,
      duplicate_rejected_archived: 0,
      skipped_existing: 0,
    };
    const qualityGateDisabled = isQualityGateDisabled();
    if (qualityGateDisabled) {
      stageRun.emit({ eventType: 'quality_gate.bypassed', status: 'warning', summary: 'Quality gates bypassed by IDEA_MAZE_DISABLE_QUALITY_GATE=1.', payload: { audit_bypass: true } });
    }
    let startedNewResearchRuns = 0;

    for (const opp of opportunities) {
      const gateEvaluation = qualityGateDisabled
        ? undefined
        : await evaluateReviewGateCandidate(db, {
          cluster_key: opp.cluster_key,
          final_score: opp.final_score,
          id: opp.id,
          run_id: opp.draft_run_id,
          slug: opp.slug,
          thesis: opp.thesis,
          title: opp.title,
        });

      if (gateEvaluation?.duplicate.duplicate) {
        const duplicateGate = gateEvaluation.duplicate;
        if (duplicateGate.duplicate) {
          if (duplicateGate.action !== 'archive_duplicate_rejected' && duplicateGate.matchedOpportunityId) {
            const attached = attachDuplicateEvidence(db, opp.id, duplicateGate.matchedOpportunityId);
            setOpportunityLifecycle(db, opp.id, 'archived', {
              payload: { archive_reason: 'duplicate_cluster', duplicate_gate: duplicateGate, evidence_attached: attached, final_score: opp.final_score },
              runId: stageRun.runId, status: 'archived',
              summary: `Attached ${opp.slug} evidence to canonical ${duplicateGate.matchedSlug}.`,
            });
            stageRun.emit({ eventType: 'opportunity.duplicate_attached', opportunityId: opp.id, status: 'warning', summary: `Attached duplicate evidence to ${duplicateGate.matchedSlug}.`, payload: { duplicate_gate: duplicateGate, evidence_attached: attached } });
            summary.skipped_existing++;
            continue;
          }
          setOpportunityLifecycle(db, opp.id, 'archived', {
            payload: {
              archive_reason: 'duplicate_rejected_opportunity',
              duplicate_gate: duplicateGate,
              final_score: opp.final_score,
            },
            runId: stageRun.runId,
            status: 'archived',
            summary: `Archived ${opp.slug}: duplicate of rejected opportunity ${duplicateGate.matchedSlug}.`,
          });
          stageRun.emit({
            eventType: 'opportunity.duplicate_archived',
            opportunityId: opp.id,
            payload: { duplicate_gate: duplicateGate, slug: opp.slug },
            status: 'warning',
            summary: `Archived duplicate rejected opportunity ${opp.slug}.`,
          });
          summary.duplicate_rejected_archived++;
          continue;
        }
      }

      const evidenceQuality = gateEvaluation?.deterministic;
      const alignment = gateEvaluation?.alignment ?? undefined;
      const policy = gateEvaluation?.policy ?? classifyOpportunityForAutomation({
        finalScore: opp.final_score,
      });

      stageRun.emit({
        eventType: 'opportunity.evidence_evaluated',
        opportunityId: opp.id,
        payload: {
          alignment,
          automation_score: policy.automationScore,
          deterministic_evidence: evidenceQuality,
          final_score: opp.final_score,
          quality_gate_bypassed: qualityGateDisabled,
          review_gate_evaluation: gateEvaluation,
        },
        status: gateEvaluation?.disposition === 'review_eligible' || qualityGateDisabled
          ? 'ok'
          : 'warning',
        summary: `Evidence evaluated for ${opp.slug}.`,
      });

      if (evidenceQuality && evidenceQuality.disposition !== 'review_eligible') {
        setOpportunityLifecycle(db, opp.id, 'archived', {
          payload: {
            archive_reason: 'evidence_quality_gate',
            automation_disposition: policy.disposition,
            automation_score: policy.automationScore,
            effective_score_bucket: policy.bucket,
            evidence_quality: evidenceQuality,
            final_score: opp.final_score,
            market_score: opp.market_score,
            taste_adjustment: opp.taste_adjustment,
          },
          runId: stageRun.runId,
          status: 'archived',
          summary: `Archived ${opp.slug}: evidence quality gate (${evidenceQuality.reasons.join(', ')}).`,
        });
        stageRun.emit({
          eventType: 'opportunity.quality_gate_archived',
          opportunityId: opp.id,
          payload: {
            automation_score: policy.automationScore,
            evidence_quality: evidenceQuality,
            final_score: opp.final_score,
            slug: opp.slug,
          },
          status: 'warning',
          summary: `Quality gate archived ${opp.slug}.`,
        });
        summary.quality_gate_archived++;
        if (evidenceQuality.reasons.includes('insufficient_independent_buyer_sources')) {
          summary.needs_more_evidence++;
        }
        if (evidenceQuality.reasons.includes('promo_dominated')) {
          summary.promo_filtered++;
        }
        continue;
      }

      if (alignment && alignment.disposition !== 'review_eligible') {
        setOpportunityLifecycle(db, opp.id, 'archived', {
          payload: { archive_reason: 'evidence_alignment_gate', alignment, automation_score: policy.automationScore, evidence_quality: evidenceQuality, final_score: opp.final_score },
          runId: stageRun.runId, status: 'archived', summary: `Archived ${opp.slug}: evidence alignment (${alignment.reasons.join(', ')}).`,
        });
        summary.quality_gate_archived++;
        summary.needs_more_evidence++;
        continue;
      }

      if (policy.disposition === 'ignore') {
        summary.ignored++;
        continue;
      }

      setOpportunityLifecycle(db, opp.id, 'shortlisted', {
        payload: {
          final_score: opp.final_score,
          market_score: opp.market_score,
          automation_disposition: policy.disposition,
          automation_score: policy.automationScore,
          evidence_alignment: alignment,
          evidence_quality: evidenceQuality,
          score_bucket: policy.bucket,
          taste_adjustment: opp.taste_adjustment,
        },
        runId: stageRun.runId,
        summary: `Opportunity shortlisted at final score ${opp.final_score}.`,
      });

      if (opp.draft_run_id) {
        setOpportunityLifecycle(db, opp.id, 'review_gate', {
          payload: {
            draft_run_id: opp.draft_run_id,
            score_bucket: policy.bucket,
          },
          runId: stageRun.runId,
          summary: `Existing research draft #${opp.draft_run_id} is awaiting review.`,
        });
        console.log(
          `Existing research draft #${opp.draft_run_id} for ${opp.slug} left at review gate.`,
        );
        summary.review_gate_existing++;
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
        requestedBy: 'system',
        runIdForEvents: stageRun.runId,
      });

      if (result.status === 'review_gate') {
        summary.review_gate_new++;
      } else {
        summary.needs_more_evidence++;
      }
    }

    console.log('\nOpportunity processing summary:');
    console.log(
      `  existing drafts at review gate:     ${summary.review_gate_existing}`,
    );
    console.log(
      `  new drafts at review gate:          ${summary.review_gate_new}`,
    );
    console.log(
      `  skipped existing history:           ${summary.skipped_existing}`,
    );
    console.log(
      `  deferred due to per-run budget:     ${summary.deferred_due_to_budget}`,
    );
    console.log(
      `  archived by quality gate:           ${summary.quality_gate_archived}`,
    );
    console.log(
      `  duplicate rejected archived:        ${summary.duplicate_rejected_archived}`,
    );
    console.log(
      `  needs more evidence:                ${summary.needs_more_evidence}`,
    );
    console.log(`  promo filtered:                     ${summary.promo_filtered}`);
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
