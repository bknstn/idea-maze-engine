import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('artifact retention inspection', () => {
  let ideaMazeHome: string;

  beforeEach(() => {
    ideaMazeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'idea-maze-artifact-retention-'),
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

  it('uses 30 days when the CLI override is absent', async () => {
    const { parseArtifactRetentionDays } = await import('./artifact-retention.ts');

    expect(parseArtifactRetentionDays(undefined)).toBe(30);
    expect(parseArtifactRetentionDays('45')).toBe(45);
    expect(() => parseArtifactRetentionDays('-1')).toThrow(
      'retention days must be a non-negative number',
    );
  });

  it('selects only artifacts older than the retention window for archived or rejected opportunities', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { inspectArtifactRetention } = await import('./artifact-retention.ts');

    const db = getDb();
    initSchema(db);
    const now = new Date('2026-08-09T12:00:00.000Z');

    const insertOpportunity = db.prepare(`
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, taste_adjustment,
        final_score, status, lifecycle_stage, cluster_key, metadata_json,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, 'thesis', 1, 1, 0, 1, ?, ?, ?, '{}', ?, ?)
    `);
    insertOpportunity.run(1, 'old-rejected', 'Old Rejected', 'archived', 'rejected', 'old-rejected', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    insertOpportunity.run(2, 'old-approved', 'Old Approved', 'active', 'approved', 'old-approved', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    insertOpportunity.run(3, 'recent-archived', 'Recent Archived', 'archived', 'archived', 'recent-archived', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    insertOpportunity.run(4, 'old-published-archive', 'Old Published Archive', 'archived', 'artifact', 'old-published-archive', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    insertOpportunity.run(5, 'active-rejected', 'Active Rejected', 'active', 'rejected', 'active-rejected', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    insertOpportunity.run(6, 'archived-approved', 'Archived Approved', 'archived', 'approved', 'archived-approved', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');

    const insertRun = db.prepare(`
      INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, completed_at_utc, metadata_json)
      VALUES (?, ?, 'opportunity', ?, 'completed', 'system', ?, ?, '{}')
    `);
    insertRun.run(1, 'research', '1', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    insertRun.run(2, 'explore', '1', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    insertRun.run(3, 'research', '2', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    insertRun.run(4, 'research', '3', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    insertRun.run(5, 'research', '4', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    insertRun.run(6, 'explore', '1', '2026-06-02T00:00:00.000Z', '2026-06-02T00:00:00.000Z');
    insertRun.run(7, 'research', '5', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');
    insertRun.run(8, 'research', '6', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z');

    db.prepare(`INSERT INTO artifacts (id, opportunity_id, run_id, path, created_at_utc) VALUES (1, 1, 1, '/managed/old-rejected.md', '2026-06-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO exploration_artifacts (id, opportunity_id, run_id, path, brief_json, created_at_utc) VALUES (1, 1, 2, '/managed/old-rejected-exploration.md', '{}', '2026-06-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO artifacts (id, opportunity_id, run_id, path, created_at_utc) VALUES (2, 2, 3, '/managed/old-approved.md', '2026-06-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO artifacts (id, opportunity_id, run_id, path, created_at_utc) VALUES (3, 3, 4, '/managed/recent-archived.md', '2026-08-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO artifacts (id, opportunity_id, run_id, path, created_at_utc) VALUES (4, 4, 5, '/managed/old-published-archive.md', '2026-06-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO exploration_artifacts (id, opportunity_id, run_id, path, brief_json, created_at_utc) VALUES (2, 1, 6, '/managed/old-rejected-exploration.md', '{}', '2026-06-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO artifacts (id, opportunity_id, run_id, path, created_at_utc) VALUES (5, 5, 7, '/managed/active-rejected.md', '2026-06-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO artifacts (id, opportunity_id, run_id, path, created_at_utc) VALUES (6, 6, 8, '/managed/archived-approved.md', '2026-06-01T00:00:00.000Z')`).run();

    const result = inspectArtifactRetention(db, { now, retentionDays: 30 });

    expect(result.retention_days).toBe(30);
    expect(result.cutoff_utc).toBe('2026-07-10T12:00:00.000Z');
    expect(result.eligible_count).toBe(4);
    expect(result.eligible_files).toBe(3);
    expect(result.candidates.map((candidate) => [candidate.kind, candidate.path])).toEqual([
      ['artifact', '/managed/old-rejected.md'],
      ['artifact', '/managed/old-published-archive.md'],
      ['exploration', '/managed/old-rejected-exploration.md'],
      ['exploration', '/managed/old-rejected-exploration.md'],
    ]);
    expect(result.candidates.map((candidate) => candidate.opportunity_slug)).toEqual([
      'old-rejected',
      'old-published-archive',
      'old-rejected',
      'old-rejected',
    ]);
  });

  it('treats an artifact created exactly at the cutoff as eligible', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { inspectArtifactRetention } = await import('./artifact-retention.ts');

    const db = getDb();
    initSchema(db);
    db.prepare(`INSERT INTO opportunities (id, slug, title, thesis, score, market_score, taste_adjustment, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc) VALUES (1, 'cutoff', 'Cutoff', 'thesis', 1, 1, 0, 1, 'archived', 'rejected', 'cutoff', '{}', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, completed_at_utc, metadata_json) VALUES (1, 'research', 'opportunity', '1', 'rejected', 'system', '2026-07-10T12:00:00.000Z', '2026-07-10T12:00:00.000Z', '{}')`).run();
    db.prepare(`INSERT INTO artifacts (id, opportunity_id, run_id, path, created_at_utc) VALUES (1, 1, 1, '/managed/cutoff.md', '2026-07-10T12:00:00.000Z')`).run();

    const result = inspectArtifactRetention(db, {
      now: new Date('2026-08-09T12:00:00.000Z'),
      retentionDays: 30,
    });

    expect(result.eligible_count).toBe(1);
  });
});
