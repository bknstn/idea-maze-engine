import type Database from 'better-sqlite3';

import { setOpportunityLifecycle } from './opportunity-state.ts';
import { recordRunEvent } from './run-events.ts';

export type RejectionReason =
  | 'duplicate'
  | 'weak_wtp'
  | 'source_contamination'
  | 'crowded_no_wedge'
  | 'generic_ai_wrapper'
  | 'consumer_retention_risk'
  | 'fallback_or_incoherent'
  | 'not_founder_fit';

export interface ApplyHumanReviewDecisionInput {
  decidedBy?: string;
  decision: 'approved' | 'rejected';
  notes?: string | null;
  reasons?: RejectionReason[];
  runId: number;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getRun(db: Database.Database, runId: number): {
  metadata_json: string;
  target_id: string | null;
} {
  const run = db
    .prepare('SELECT target_id, metadata_json FROM runs WHERE id = ?')
    .get(runId) as { metadata_json: string; target_id: string | null } | undefined;
  if (!run) throw new Error(`Run #${runId} not found.`);
  return run;
}

export function applyHumanReviewDecision(
  db: Database.Database,
  input: ApplyHumanReviewDecisionInput,
): void {
  const now = new Date().toISOString();
  const run = getRun(db, input.runId);
  const opportunityId = Number(run.target_id);
  if (!Number.isFinite(opportunityId)) {
    throw new Error(`Run #${input.runId} is not linked to an opportunity.`);
  }

  const decidedBy = input.decidedBy ?? 'kostya';
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

  db.prepare('UPDATE runs SET metadata_json = ? WHERE id = ?').run(
    JSON.stringify({
      ...parseMetadata(run.metadata_json),
      human_review: reviewMetadata,
    }),
    input.runId,
  );

  if (input.decision === 'rejected') {
    setOpportunityLifecycle(db, opportunityId, 'rejected', {
      actor: decidedBy,
      payload: { human_review: reviewMetadata },
      runId: input.runId,
      status: 'archived',
      summary: `Human review rejected opportunity #${opportunityId}.`,
    });
    const insertFeature = db.prepare(
      `
      INSERT OR IGNORE INTO feedback_features (
        run_id, opportunity_id, decision, feature_type, feature_value, created_at_utc
      ) VALUES (?, ?, ?, 'rejection_reason', ?, ?)
    `,
    );
    for (const reason of reasons) {
      insertFeature.run(input.runId, opportunityId, input.decision, reason, now);
    }
  } else {
    setOpportunityLifecycle(db, opportunityId, 'approved', {
      actor: decidedBy,
      payload: { human_review: reviewMetadata },
      runId: input.runId,
      status: 'active',
      summary: `Human review approved opportunity #${opportunityId}.`,
    });
  }

  recordRunEvent(db, {
    actor: decidedBy,
    eventType: 'human_review.applied',
    opportunityId,
    payload: reviewMetadata,
    runId: input.runId,
    stage: 'human-review',
    status: 'ok',
    summary: `Human review ${input.decision} applied.`,
  });
}
