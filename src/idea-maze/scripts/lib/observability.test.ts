import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('observability reports', () => {
  let ideaMazeHome: string;

  beforeEach(() => {
    ideaMazeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'idea-maze-observability-'),
    );
    fs.mkdirSync(path.join(ideaMazeHome, 'data'), { recursive: true });
    process.env.IDEA_MAZE_HOME = ideaMazeHome;
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import('./db.ts');
    closeDb();
    delete process.env.IDEA_MAZE_HOME;
    fs.rmSync(ideaMazeHome, { recursive: true, force: true });
  });

  it('summarizes the latest pipeline run and warnings', async () => {
    const { getDb } = await import('./db.ts');
    const { buildPipelineStatusReport, buildPipelineStatusSnapshot } =
      await import('./observability.ts');
    const { initSchema } = await import('./schema.ts');

    const db = getDb();
    initSchema(db);

    db.prepare(
      `
      INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, completed_at_utc, metadata_json)
      VALUES (1, 'pipeline', 'pipeline', 'pipeline', 'completed', 'system', '2026-04-15T06:00:00.000Z', '2026-04-15T06:05:00.000Z', '{}')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO run_events (run_id, event_type, stage, actor, status, summary, payload_json, created_at_utc)
      VALUES (1, 'pipeline.stage_completed', 'ingest-reddit', 'system', 'ok', 'ingest-reddit completed in 12ms.', '{"duration_ms":12}', '2026-04-15T06:01:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO run_events (run_id, event_type, stage, actor, status, summary, payload_json, created_at_utc)
      VALUES (1, 'validation.warning', 'research', 'system', 'warning', 'Research draft validation failed.', '{"failure_class":"validation"}', '2026-04-15T06:04:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO opportunities (id, slug, title, thesis, score, market_score, taste_adjustment, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc)
      VALUES (1, 'voice-looking', 'Voice Looking', 'Delegation pain', 9, 9, 0, 9, 'active', 'approved', 'voice-looking', '{}', '2026-04-15T06:00:00.000Z', '2026-04-15T06:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO exploration_artifacts (id, opportunity_id, run_id, path, brief_json, created_at_utc)
      VALUES (1, 1, 1, '/tmp/voice-looking.md', '{"next_action":"Interview 10 managers."}', '2026-04-15T06:06:00.000Z')
    `,
    ).run();

    const report = buildPipelineStatusReport(db);
    const snapshot = buildPipelineStatusSnapshot(db);

    expect(report).toContain('Latest pipeline run: #1');
    expect(report).toContain('ingest-reddit: ok');
    expect(report).toContain('validation');
    expect(snapshot.latest_run?.id).toBe(1);
    expect(snapshot.counts.exploration_artifacts).toBe(1);
    expect(report).toContain('1 explorations');
    expect(snapshot.stages[0]).toMatchObject({
      duration_ms: 12,
      stage: 'ingest-reddit',
      status: 'ok',
    });
    expect(snapshot.recent_warnings[0].failure_class).toBe('validation');
  });

  it('explains current lifecycle, scoring, and artifact history for one opportunity', async () => {
    const { getDb } = await import('./db.ts');
    const {
      buildArtifactsSnapshot,
      buildOpportunityExplanation,
      buildOpportunityExplanationSnapshot,
    } = await import('./observability.ts');
    const { initSchema } = await import('./schema.ts');

    const db = getDb();
    initSchema(db);

    db.prepare(
      `
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, taste_adjustment, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES (1, 'finance-ops', 'Finance Ops', 'Invoice pain', 8.4, 8.4, 0.3, 8.7, 'active', 'artifact', 'finance-ops', ?, '2026-04-15T06:00:00.000Z', '2026-04-15T06:00:00.000Z')
    `,
    ).run(
      JSON.stringify({
        insight_count: 4,
        source_count: 2,
        top_source_patterns: ['templates-and-ops'],
        top_harvest_signals: ['manual-work'],
      }),
    );
    db.prepare(
      `
      INSERT INTO source_items (
        id, source, external_id, text, timestamp_utc, ingested_at_utc, raw_path, content_hash, metadata_json
      )
      VALUES (1, 'reddit', 'reddit-1', 'Manual reconciliation keeps showing up.', '2026-04-15T06:00:00.000Z', '2026-04-15T06:00:00.000Z', '/tmp/source.json', 'hash-1', ?)
    `,
    ).run(
      JSON.stringify({
        harvest_signals: ['manual-work'],
        source_patterns: ['templates-and-ops'],
      }),
    );
    db.prepare(
      `
      INSERT INTO insights (id, source_item_id, insight_type, summary, evidence_score, confidence, status, metadata_json, created_at_utc)
      VALUES (1, 1, 'workflow_gap', 'Manual reconciliation causes delays.', 0.8, 0.8, 'new', '{}', '2026-04-15T06:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO opportunity_sources (opportunity_id, source_item_id)
      VALUES (1, 1)
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES (1, 'research', 'opportunity', '1', 'published', 'system', '2026-04-15T06:10:00.000Z', '{}')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO artifacts (id, opportunity_id, run_id, path, version, approved_at_utc, created_at_utc)
      VALUES (1, 1, 1, '/tmp/finance-ops.md', 1, '2026-04-15T06:20:00.000Z', '2026-04-15T06:20:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO taste_profile (feature_type, feature_value, approved_count, rejected_count, learned_weight, updated_at_utc)
      VALUES ('cluster_key', 'finance-ops', 1, 0, 0.5, '2026-04-15T06:20:00.000Z')
    `,
    ).run();

    const report = buildOpportunityExplanation(db, 'finance-ops');
    const snapshot = buildOpportunityExplanationSnapshot(db, 'finance-ops');
    const artifacts = buildArtifactsSnapshot(db);

    expect(report).toContain('Lifecycle: artifact');
    expect(report).toContain('Scores: market=8.4 taste=0.3 final=8.7');
    expect(report).toContain('Artifact history');
    expect(report).toContain('/tmp/finance-ops.md');
    expect(snapshot.opportunity.slug).toBe('finance-ops');
    expect(snapshot.evidence.source_summary).toEqual([
      { count: 1, source: 'reddit' },
    ]);
    expect(snapshot.artifact_history[0].path).toBe('/tmp/finance-ops.md');
    expect(artifacts.artifacts[0]).toMatchObject({
      opportunity_slug: 'finance-ops',
      path: '/tmp/finance-ops.md',
    });
    expect(artifacts.artifacts[0]).not.toHaveProperty(
      ['export', 'status'].join('_'),
    );
  });
});
