import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyHumanReviewDecision } from './human-review.ts';
import { initSchema } from './schema.ts';

function seedRun(db: Database.Database): { opportunityId: number; runId: number } {
  const now = '2026-06-01T00:00:00.000Z';
  const opportunity = db
    .prepare(
      `
      INSERT INTO opportunities (
        slug, title, thesis, score, market_score, taste_adjustment, final_score,
        status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      ) VALUES ('invoice-reconciliation', 'Invoice reconciliation', 'Manual invoice matching wastes hours.', 9, 9, 0, 9,
        'active', 'review_gate', 'invoice-reconciliation', '{}', ?, ?)
    `,
    )
    .run(now, now);
  const opportunityId = Number(opportunity.lastInsertRowid);
  const run = db
    .prepare(
      `
      INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES ('research', 'opportunity', ?, 'review_gate', 'system', ?, '{}')
    `,
    )
    .run(String(opportunityId), now);
  return { opportunityId, runId: Number(run.lastInsertRowid) };
}

describe('applyHumanReviewDecision', () => {
  it('stores rejection reason labels in approvals, run metadata, and feedback features', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const { opportunityId, runId } = seedRun(db);

    applyHumanReviewDecision(db, {
      decision: 'rejected',
      notes: 'Source-poor duplicate.',
      reasons: ['duplicate', 'weak_wtp'],
      runId,
    });

    const approval = db.prepare('SELECT decision, notes FROM approvals WHERE run_id = ?').get(runId) as {
      decision: string;
      notes: string;
    };
    const run = db.prepare('SELECT metadata_json FROM runs WHERE id = ?').get(runId) as {
      metadata_json: string;
    };
    const opportunity = db.prepare('SELECT lifecycle_stage, status FROM opportunities WHERE id = ?').get(opportunityId) as {
      lifecycle_stage: string;
      status: string;
    };
    const featureValues = (
      db.prepare("SELECT feature_value FROM feedback_features WHERE feature_type = 'rejection_reason' ORDER BY feature_value").all() as { feature_value: string }[]
    ).map((row) => row.feature_value);

    expect(approval.decision).toBe('rejected');
    expect(JSON.parse(approval.notes)).toMatchObject({
      notes: 'Source-poor duplicate.',
      reasons: ['duplicate', 'weak_wtp'],
    });
    expect(JSON.parse(run.metadata_json).human_review).toMatchObject({
      decision: 'rejected',
      decided_by: 'kostya',
      reasons: ['duplicate', 'weak_wtp'],
    });
    expect(opportunity).toEqual({ lifecycle_stage: 'rejected', status: 'archived' });
    expect(featureValues).toEqual(['duplicate', 'weak_wtp']);
  });
});
