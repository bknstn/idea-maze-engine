import type Database from 'better-sqlite3';

import {
  alignOpportunityEvidence,
  type EvidenceAlignmentResult,
} from './evidence-alignment.ts';
import {
  findOpportunityDuplicate,
  type DuplicateGateResult,
} from './duplicate-opportunities.ts';
import {
  evaluateEvidenceQuality,
  type EvidenceQualityResult,
  type EvidenceSourceSummary,
} from './evidence-quality.ts';
import { setOpportunityLifecycle } from './opportunity-state.ts';
import {
  classifyOpportunityForAutomation,
  type OpportunityPolicy,
} from './opportunity-policy.ts';
import { recordRunEvent } from './run-events.ts';

export interface ReviewGateEvaluation {
  alignment: EvidenceAlignmentResult | null;
  alignedBuyerSourceCount: number;
  automationScore: number;
  deterministic: EvidenceQualityResult;
  disposition: 'review_eligible' | 'needs_more_evidence' | 'auto_reject';
  duplicate: DuplicateGateResult;
  finalScore: number;
  opportunityId: number;
  policy: OpportunityPolicy;
  reasons: string[];
  slug: string;
}

export type EvidenceAligner = typeof alignOpportunityEvidence;

interface Candidate {
  cluster_key: string;
  final_score: number;
  id: number;
  run_id: number | null;
  slug: string;
  thesis: string;
  title: string;
}

export function fetchReviewGateSources(
  db: Database.Database,
  opportunityId: number,
): EvidenceSourceSummary[] {
  return db.prepare(`
    SELECT si.id, si.source, si.title, si.text, si.canonical_url,
           si.channel_or_label, si.content_hash, si.metadata_json
    FROM source_items si
    JOIN opportunity_sources os ON os.source_item_id = si.id
    WHERE os.opportunity_id = ?
    ORDER BY si.id
  `).all(opportunityId) as EvidenceSourceSummary[];
}

export async function evaluateReviewGateCandidate(
  db: Database.Database,
  candidate: Candidate,
  aligner: EvidenceAligner = alignOpportunityEvidence,
): Promise<ReviewGateEvaluation> {
  const duplicate = findOpportunityDuplicate(db, candidate);
  const sources = fetchReviewGateSources(db, candidate.id);
  const deterministic = evaluateEvidenceQuality(sources, {
    finalScore: candidate.final_score,
    title: candidate.title,
    thesis: candidate.thesis,
    validationStatus: null,
  });
  const alignment = !duplicate.duplicate && deterministic.disposition === 'review_eligible'
    ? await aligner({ title: candidate.title, thesis: candidate.thesis, sources })
    : null;
  const policy = classifyOpportunityForAutomation({
    alignment: alignment ?? undefined,
    evidenceQuality: deterministic,
    finalScore: candidate.final_score,
  });
  const reasons = [
    ...new Set([
      ...duplicate.reasons.map((reason) => `duplicate:${reason}`),
      ...deterministic.reasons,
      ...(alignment?.reasons ?? []),
    ]),
  ];
  const disposition = duplicate.duplicate ||
    deterministic.disposition !== 'review_eligible' ||
    alignment?.disposition !== 'review_eligible'
    ? 'needs_more_evidence'
    : 'review_eligible';

  return {
    alignment,
    alignedBuyerSourceCount: alignment?.alignedBuyerSourceCount ?? 0,
    automationScore: policy.automationScore ?? candidate.final_score,
    deterministic,
    disposition,
    duplicate,
    finalScore: candidate.final_score,
    opportunityId: candidate.id,
    policy,
    reasons,
    slug: candidate.slug,
  };
}

export async function revalidateReviewGate(
  db: Database.Database,
  options: { apply?: boolean; aligner?: EvidenceAligner } = {},
): Promise<ReviewGateEvaluation[]> {
  const candidates = db.prepare(`
    SELECT o.id, o.slug, o.title, o.thesis, o.cluster_key, o.final_score,
           (
             SELECT r.id
             FROM runs r
             WHERE r.target_type = 'opportunity'
               AND (r.target_id = CAST(o.id AS TEXT) OR r.target_id = o.slug)
               AND r.status IN ('draft_ready', 'review_gate')
             ORDER BY r.id DESC
             LIMIT 1
           ) AS run_id
    FROM opportunities o
    WHERE o.lifecycle_stage NOT IN ('approved', 'rejected')
      AND (
        o.lifecycle_stage = 'review_gate'
        OR EXISTS (
          SELECT 1
          FROM runs r
          WHERE r.target_type = 'opportunity'
            AND (r.target_id = CAST(o.id AS TEXT) OR r.target_id = o.slug)
            AND r.status IN ('draft_ready', 'review_gate')
        )
      )
    ORDER BY o.id
  `).all() as Candidate[];
  const results: ReviewGateEvaluation[] = [];
  const aligner = options.aligner ?? alignOpportunityEvidence;

  for (const candidate of candidates) {
    const evaluation = await evaluateReviewGateCandidate(db, candidate, aligner);
    results.push(evaluation);
    if (!options.apply || evaluation.disposition === 'review_eligible') continue;

    db.transaction(() => {
      setOpportunityLifecycle(db, candidate.id, 'archived', {
        payload: {
          archive_reason: 'review_gate_revalidation',
          review_gate_evaluation: evaluation,
        },
        runId: candidate.run_id,
        status: 'archived',
        summary: `Review-gate revalidation archived ${candidate.slug}.`,
      });
      if (candidate.run_id !== null) {
        db.prepare(`
          UPDATE runs
          SET status = 'needs_more_evidence',
              completed_at_utc = COALESCE(completed_at_utc, ?)
          WHERE id = ?
        `).run(new Date().toISOString(), candidate.run_id);
      }
      recordRunEvent(db, {
        eventType: 'review_gate.revalidated',
        opportunityId: candidate.id,
        payload: evaluation,
        runId: candidate.run_id,
        stage: 'review-gate',
        status: 'warning',
        summary: `Revalidated and archived ${candidate.slug}: ${evaluation.reasons.join(', ')}`,
      });
    })();
  }
  return results;
}
