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

    const result = applyHumanReviewDecision(db, {
      decision: 'rejected',
      notes: 'Source-poor duplicate.',
      reasons: ['duplicate', 'weak_wtp'],
      runId,
    });

    const approval = db.prepare('SELECT decision, notes FROM approvals WHERE run_id = ?').get(runId) as {
      decision: string;
      notes: string;
    };
    const run = db.prepare('SELECT status, completed_at_utc, metadata_json FROM runs WHERE id = ?').get(runId) as {
      completed_at_utc: string | null;
      metadata_json: string;
      status: string;
    };
    const opportunity = db.prepare('SELECT lifecycle_stage, status FROM opportunities WHERE id = ?').get(opportunityId) as {
      lifecycle_stage: string;
      status: string;
    };
    const featureValues = (
      db.prepare("SELECT feature_value FROM feedback_features WHERE feature_type = 'rejection_reason' ORDER BY feature_value").all() as { feature_value: string }[]
    ).map((row) => row.feature_value);

    expect(result).toMatchObject({
      convertedPublishedFeedback: 0,
      decision: 'rejected',
      opportunityId,
      runId,
      slug: 'invoice-reconciliation',
    });
    expect(approval.decision).toBe('rejected');
    expect(JSON.parse(approval.notes)).toMatchObject({
      notes: 'Source-poor duplicate.',
      reasons: ['duplicate', 'weak_wtp'],
    });
    expect(run.status).toBe('rejected');
    expect(run.completed_at_utc).toEqual(expect.any(String));
    expect(JSON.parse(run.metadata_json).human_review).toMatchObject({
      decision: 'rejected',
      decided_by: 'kostya',
      reasons: ['duplicate', 'weak_wtp'],
    });
    expect(opportunity).toEqual({ lifecycle_stage: 'rejected', status: 'archived' });
    expect(featureValues).toEqual(['duplicate', 'weak_wtp']);
  });

  it('reverses a previously approved opportunity and converts positive taste feedback', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const { opportunityId, runId } = seedRun(db);
    const now = '2026-06-02T00:00:00.000Z';

    db.prepare("UPDATE opportunities SET lifecycle_stage = 'approved', status = 'active' WHERE id = ?").run(
      opportunityId,
    );
    db.prepare("UPDATE runs SET status = 'approved', target_id = 'invoice-reconciliation' WHERE id = ?").run(runId);
    db.prepare(
      `INSERT INTO feedback_features (run_id, opportunity_id, decision, feature_type, feature_value, created_at_utc)
       VALUES (?, ?, 'published', 'topic', 'bookkeeping', ?)`,
    ).run(runId, opportunityId, now);
    db.prepare(
      `INSERT INTO taste_profile (feature_type, feature_value, approved_count, rejected_count, learned_weight, updated_at_utc)
       VALUES ('topic', 'bookkeeping', 2, 0, 0.5, ?)`,
    ).run(now);

    const result = applyHumanReviewDecision(db, {
      decision: 'rejected',
      notes: 'Weak app wrapper; spreadsheet tools cover tracking.',
      reasons: ['weak_app_wrapper', 'trust_access_risk'],
      runId,
    });

    const opportunity = db.prepare('SELECT lifecycle_stage, status FROM opportunities WHERE id = ?').get(opportunityId) as {
      lifecycle_stage: string;
      status: string;
    };
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    const decisions = (
      db.prepare('SELECT feature_type, feature_value, decision FROM feedback_features WHERE run_id = ? ORDER BY feature_type, feature_value').all(runId) as {
        decision: string;
        feature_type: string;
        feature_value: string;
      }[]
    );
    const taste = db.prepare("SELECT approved_count, rejected_count, learned_weight FROM taste_profile WHERE feature_type = 'topic' AND feature_value = 'bookkeeping'").get() as {
      approved_count: number;
      learned_weight: number;
      rejected_count: number;
    };

    expect(result.convertedPublishedFeedback).toBe(1);
    expect(opportunity).toEqual({ lifecycle_stage: 'rejected', status: 'archived' });
    expect(run.status).toBe('rejected');
    expect(decisions).toEqual([
      { decision: 'rejected', feature_type: 'rejection_reason', feature_value: 'trust_access_risk' },
      { decision: 'rejected', feature_type: 'rejection_reason', feature_value: 'weak_app_wrapper' },
      { decision: 'ignored', feature_type: 'topic', feature_value: 'bookkeeping' },
    ]);
    expect(taste.approved_count).toBe(1);
    expect(taste.rejected_count).toBe(1);
    expect(taste.learned_weight).toBeCloseTo(0);
  });
});
