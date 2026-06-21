import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('artifact publication flow', () => {
  let ideaMazeHome: string;
  let ipcDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00.000Z'));
    ideaMazeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-publication-'));
    ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-ipc-'));
    fs.mkdirSync(path.join(ideaMazeHome, 'data'), { recursive: true });
    process.env.IDEA_MAZE_HOME = ideaMazeHome;
    process.env.IDEA_MAZE_IPC = ipcDir;
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import('./db.ts');
    closeDb();
    vi.useRealTimers();
    delete process.env.IDEA_MAZE_HOME;
    delete process.env.IDEA_MAZE_IPC;
    fs.rmSync(ideaMazeHome, { recursive: true, force: true });
    fs.rmSync(ipcDir, { recursive: true, force: true });
  });

  async function seedPublishableRun() {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const db = getDb();
    initSchema(db);

    db.prepare(
      `
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES (1, 'finance-ops', 'Finance Ops', 'Invoice pain', 8, 8, 8, 'active', 'researching', 'finance-ops', '{}', '2026-04-15T06:00:00.000Z', '2026-04-15T06:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO source_items (
        id, source, external_id, text, timestamp_utc, ingested_at_utc, raw_path, content_hash, metadata_json
      )
      VALUES (1, 'reddit', 'reddit-1', 'Teams keep reconciling invoices by hand.', '2026-04-15T06:00:00.000Z', '2026-04-15T06:00:00.000Z', '/tmp/source.json', 'hash-1', ?)
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
      VALUES (1, 'research', 'opportunity', '1', 'draft_ready', 'system', '2026-04-15T06:10:00.000Z', ?)
    `,
    ).run(
      JSON.stringify({
        prompt_metadata: {
          model: 'claude-sonnet-4-6',
          validation_status: 'valid',
        },
        draft: {
          opportunity_slug: 'finance-ops',
          thesis: 'Invoice reconciliation is painful.',
          evidence_from_inbox: ['None'],
          evidence_from_telegram: ['None'],
          evidence_from_reddit: ['Manual reconciliation keeps showing up.'],
          external_market_check: ['None'],
          product_concept: 'Finance ops workflow app',
          mvp_scope: ['Core workflow'],
          implementation_plan: ['Ship the narrow slice'],
          distribution_plan: ['Finance ops communities'],
          risks: ['Incumbents'],
          source_refs: [1],
        },
      }),
    );

    return db;
  }

  it('records publication feedback and writes only a local artifact', async () => {
    const db = await seedPublishableRun();
    const { publishResearchArtifact } = await import('./review.ts');

    const result = publishResearchArtifact(db, 1, 'Strong fit');

    const opportunity = db
      .prepare(
        `
      SELECT lifecycle_stage
      FROM opportunities
      WHERE id = 1
    `,
      )
      .get() as { lifecycle_stage: string };
    const feedbackCount = (
      db.prepare('SELECT COUNT(*) as n FROM feedback_features').get() as any
    ).n;
    const publicationEvent = db
      .prepare(
        `
      SELECT summary, payload_json
      FROM run_events
      WHERE run_id = 1 AND event_type = 'artifact.published'
      LIMIT 1
    `,
      )
      .get() as { payload_json: string; summary: string } | undefined;
    expect(opportunity.lifecycle_stage).toBe('artifact');
    expect(feedbackCount).toBeGreaterThan(0);
    expect(publicationEvent?.summary).toContain('published');
    const publicationPayload = JSON.parse(publicationEvent?.payload_json ?? '{}');
    expect(publicationPayload).not.toHaveProperty(
      ['github', 'export', 'status'].join('_'),
    );
    expect(result.path).toContain(
      path.join('data', 'artifacts', '2026', '04', '18', 'finance-ops.md'),
    );
    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.existsSync(path.join(ipcDir, 'tasks'))).toBe(false);
  });

  it('rejects artifact slugs that could escape the artifact directory', async () => {
    const db = await seedPublishableRun();
    db.prepare(
      `
      UPDATE runs
      SET metadata_json = ?
      WHERE id = 1
    `,
    ).run(
      JSON.stringify({
        prompt_metadata: {
          model: 'claude-sonnet-4-6',
          validation_status: 'valid',
        },
        draft: {
          opportunity_slug: '../outside',
          thesis: 'Invoice reconciliation is painful.',
          evidence_from_inbox: ['None'],
          evidence_from_telegram: ['None'],
          evidence_from_reddit: ['Manual reconciliation keeps showing up.'],
          external_market_check: ['None'],
          product_concept: 'Finance ops workflow app',
          mvp_scope: ['Core workflow'],
          implementation_plan: ['Ship the narrow slice'],
          distribution_plan: ['Finance ops communities'],
          risks: ['Incumbents'],
          source_refs: [1],
        },
      }),
    );
    const { publishResearchArtifact } = await import('./review.ts');

    expect(() => publishResearchArtifact(db, 1)).toThrow(
      'Invalid artifact slug',
    );
    expect(
      fs.existsSync(path.join(ideaMazeHome, 'data', 'outside.md')),
    ).toBe(false);
  });
});
