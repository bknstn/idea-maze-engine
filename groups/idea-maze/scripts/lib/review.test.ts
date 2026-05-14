import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('artifact publication flow', () => {
  let groupDir: string;
  let ipcDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00.000Z'));
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-publication-'));
    ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-ipc-'));
    fs.mkdirSync(path.join(groupDir, 'data'), { recursive: true });
    process.env.WORKSPACE_GROUP = groupDir;
    process.env.WORKSPACE_IPC = ipcDir;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_URL;
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import('./db.ts');
    closeDb();
    vi.useRealTimers();
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH;
    delete process.env.IDEA_MAZE_ARTIFACTS_REPO_URL;
    delete process.env.WORKSPACE_GROUP;
    delete process.env.WORKSPACE_IPC;
    fs.rmSync(groupDir, { recursive: true, force: true });
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

  it('records publication feedback and leaves GitHub export disabled when mirror config is absent', async () => {
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
    const exportCount = (
      db.prepare('SELECT COUNT(*) as n FROM artifact_exports').get() as any
    ).n;

    expect(result.githubExport.status).toBe('disabled');
    expect(opportunity.lifecycle_stage).toBe('artifact');
    expect(feedbackCount).toBeGreaterThan(0);
    expect(publicationEvent?.summary).toContain('published');
    expect(publicationEvent?.payload_json).toContain(
      '"github_export_status":"disabled"',
    );
    expect(exportCount).toBe(0);
  });

  it('queues a host-side GitHub export row and writes an IPC wakeup when mirror config is present', async () => {
    process.env.IDEA_MAZE_ARTIFACTS_REPO_URL =
      'git@github.com:bknstn/idea-maze-artifacts.git';
    process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH = 'main';
    vi.resetModules();

    const db = await seedPublishableRun();
    const { publishResearchArtifact } = await import('./review.ts');

    const result = publishResearchArtifact(db, 1, 'Strong fit');

    const artifactExport = db
      .prepare(
        `
      SELECT status, relative_path, repo_url, repo_branch, attempt_count, last_error
      FROM artifact_exports
      LIMIT 1
    `,
      )
      .get() as {
      attempt_count: number;
      last_error: string | null;
      relative_path: string;
      repo_branch: string;
      repo_url: string;
      status: string;
    };
    const queuedEvent = db
      .prepare(
        `
      SELECT payload_json, summary
      FROM run_events
      WHERE run_id = 1 AND event_type = 'artifact_export.queued'
      LIMIT 1
    `,
      )
      .get() as { payload_json: string; summary: string } | undefined;
    const taskFiles = fs.readdirSync(path.join(ipcDir, 'tasks'));

    expect(result.githubExport.status).toBe('queued');
    expect(artifactExport.status).toBe('pending');
    expect(artifactExport.relative_path).toBe(
      'data/artifacts/2026/04/18/finance-ops.md',
    );
    expect(artifactExport.repo_url).toBe(
      'git@github.com:bknstn/idea-maze-artifacts.git',
    );
    expect(artifactExport.repo_branch).toBe('main');
    expect(artifactExport.attempt_count).toBe(0);
    expect(artifactExport.last_error).toBeNull();
    expect(queuedEvent?.summary).toContain('queued for host processing');
    expect(queuedEvent?.payload_json).toContain('"ipc_wakeup_sent":true');
    expect(taskFiles).toHaveLength(1);
  });
});
