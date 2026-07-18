import type Database from 'better-sqlite3';

import { recordRunEvent } from './run-events.ts';

export const REJECTION_REASONS = [
  'duplicate',
  'weak_wtp',
  'source_contamination',
  'crowded_no_wedge',
  'generic_ai_wrapper',
  'consumer_retention_risk',
  'fallback_or_incoherent',
  'not_founder_fit',
  'weak_app_wrapper',
  'trust_access_risk',
  'thin_evidence',
  'low_wtp',
  'source_mismatch',
  'contradicted_thesis',
  'promo_only_support',
  'irrelevant_sources',
  'duplicate_cluster',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface ApplyHumanReviewDecisionInput {
  decidedBy?: string;
  decision: 'approved' | 'rejected';
  notes?: string | null;
  reasons?: RejectionReason[];
  runId: number;
}

export interface ApplyHumanReviewDecisionResult {
  convertedPublishedFeedback: number;
  decision: 'approved' | 'rejected';
  opportunityId: number;
  runId: number;
  slug: string;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveRunOpportunity(db: Database.Database, runId: number): {
  metadata_json: string;
  opportunity_id: number;
  opportunity_lifecycle_stage: string;
  opportunity_status: string;
  slug: string;
  target_id: string | null;
} {
  const row = db
    .prepare(
      `
      SELECT r.target_id,
             r.metadata_json,
             o.id AS opportunity_id,
             o.slug,
             o.lifecycle_stage AS opportunity_lifecycle_stage,
             o.status AS opportunity_status
      FROM runs r
      LEFT JOIN opportunities o
        ON r.target_type = 'opportunity'
       AND (r.target_id = CAST(o.id AS TEXT) OR r.target_id = o.slug)
      WHERE r.id = ?
    `,
    )
    .get(runId) as
    | {
        metadata_json: string;
        opportunity_id: number | null;
        opportunity_lifecycle_stage: string | null;
        opportunity_status: string | null;
        slug: string | null;
        target_id: string | null;
      }
    | undefined;
  if (!row) throw new Error(`Run #${runId} not found.`);
  if (!row.opportunity_id || !row.slug || !row.opportunity_lifecycle_stage || !row.opportunity_status) {
    throw new Error(`Run #${runId} is not linked to an opportunity.`);
  }
  return {
    metadata_json: row.metadata_json,
    opportunity_id: row.opportunity_id,
    opportunity_lifecycle_stage: row.opportunity_lifecycle_stage,
    opportunity_status: row.opportunity_status,
    slug: row.slug,
    target_id: row.target_id,
  };
}

function setHumanReviewedLifecycle(
  db: Database.Database,
  input: {
    actor: string;
    decision: 'approved' | 'rejected';
    opportunityId: number;
    previousLifecycle: string;
    previousStatus: string;
    reviewMetadata: Record<string, unknown>;
    runId: number;
    slug: string;
  },
): void {
  const now = new Date().toISOString();
  const lifecycleStage = input.decision;
  const status = input.decision === 'approved' ? 'active' : 'archived';

  db.prepare(
    `
    UPDATE opportunities
    SET lifecycle_stage = ?,
        status = ?,
        last_reviewed_at_utc = ?,
        updated_at_utc = ?
    WHERE id = ?
  `,
  ).run(lifecycleStage, status, now, now, input.opportunityId);

  recordRunEvent(db, {
    actor: input.actor,
    eventType: 'lifecycle.transition',
    opportunityId: input.opportunityId,
    payload: {
      from: input.previousLifecycle,
      payload: { human_review: input.reviewMetadata },
      status_from: input.previousStatus,
      status_to: status,
      to: lifecycleStage,
    },
    runId: input.runId,
    stage: 'lifecycle',
    status: 'info',
    summary: `Human review set ${input.slug} to ${lifecycleStage}.`,
  });
}

function convertPublishedFeedbackToIgnored(
  db: Database.Database,
  runId: number,
  now: string,
): number {
  const publishedFeatures = db
    .prepare(
      `
      SELECT feature_type, feature_value
      FROM feedback_features
      WHERE run_id = ? AND decision = 'published'
    `,
    )
    .all(runId) as { feature_type: string; feature_value: string }[];

  if (publishedFeatures.length === 0) return 0;

  db.prepare(
    `
    UPDATE feedback_features
    SET decision = 'ignored'
    WHERE run_id = ? AND decision = 'published'
  `,
  ).run(runId);

  const adjustTaste = db.prepare(
    `
    UPDATE taste_profile
    SET approved_count = MAX(approved_count - 1, 0),
        rejected_count = rejected_count + 1,
        learned_weight = CAST((MAX(approved_count - 1, 0)) - (rejected_count + 1) AS REAL)
          / CAST((MAX(approved_count - 1, 0)) + (rejected_count + 1) + 2 AS REAL),
        updated_at_utc = ?
    WHERE feature_type = ? AND feature_value = ?
  `,
  );
  for (const feature of publishedFeatures) {
    adjustTaste.run(now, feature.feature_type, feature.feature_value);
  }
  return publishedFeatures.length;
}

export function applyHumanReviewDecision(
  db: Database.Database,
  input: ApplyHumanReviewDecisionInput,
): ApplyHumanReviewDecisionResult {
  const apply = db.transaction((): ApplyHumanReviewDecisionResult => {
    const now = new Date().toISOString();
    const run = resolveRunOpportunity(db, input.runId);
    const decidedBy = input.decidedBy ?? 'user';
    const reasons = input.decision === 'rejected' ? (input.reasons ?? []) : [];
    const reviewMetadata = {
      decided_at_utc: now,
      decided_by: decidedBy,
      decision: input.decision,
      notes: input.notes ?? null,
      reasons,
    };
    const notesPayload = JSON.stringify({
      notes: input.notes ?? null,
      reasons,
    });

    db.prepare(
      'INSERT INTO approvals (run_id, decision, notes, decided_at_utc) VALUES (?, ?, ?, ?)',
    ).run(input.runId, input.decision, notesPayload, now);

    db.prepare(
      `
      UPDATE runs
      SET status = ?,
          completed_at_utc = COALESCE(completed_at_utc, ?),
          metadata_json = ?
      WHERE id = ?
    `,
    ).run(
      input.decision,
      now,
      JSON.stringify({
        ...parseMetadata(run.metadata_json),
        human_review: reviewMetadata,
      }),
      input.runId,
    );

    let convertedPublishedFeedback = 0;
    if (input.decision === 'rejected') {
      convertedPublishedFeedback = convertPublishedFeedbackToIgnored(db, input.runId, now);
    }

    setHumanReviewedLifecycle(db, {
      actor: decidedBy,
      decision: input.decision,
      opportunityId: run.opportunity_id,
      previousLifecycle: run.opportunity_lifecycle_stage,
      previousStatus: run.opportunity_status,
      reviewMetadata,
      runId: input.runId,
      slug: run.slug,
    });

    if (input.decision === 'rejected') {
      const insertFeature = db.prepare(
        `
        INSERT OR IGNORE INTO feedback_features (
          run_id, opportunity_id, decision, feature_type, feature_value, created_at_utc
        ) VALUES (?, ?, ?, 'rejection_reason', ?, ?)
      `,
      );
      for (const reason of reasons) {
        insertFeature.run(input.runId, run.opportunity_id, input.decision, reason, now);
      }
    }

    recordRunEvent(db, {
      actor: decidedBy,
      eventType: 'human_review.applied',
      opportunityId: run.opportunity_id,
      payload: { ...reviewMetadata, converted_published_feedback: convertedPublishedFeedback },
      runId: input.runId,
      stage: 'human-review',
      status: 'ok',
      summary: `Human review ${input.decision} applied.`,
    });

    return {
      convertedPublishedFeedback,
      decision: input.decision,
      opportunityId: run.opportunity_id,
      runId: input.runId,
      slug: run.slug,
    };
  });

  return apply();
}
