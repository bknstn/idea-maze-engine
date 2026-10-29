import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getCounts', () => {
  let ideaMazeHome: string;

  beforeEach(() => {
    ideaMazeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-queries-'));
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

  it('counts running and draft-ready research as unfinished work', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { getCounts } = await import('./queries.ts');

    const db = getDb();
    initSchema(db);

    db.prepare(
      `
      INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'research',
      'opportunity',
      '1',
      'draft_ready',
      'system',
      '2026-04-15T06:00:00.000Z',
      '{}',
    );
    db.prepare(
      `
      INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'research',
      'opportunity',
      '2',
      'running',
      'system',
      '2026-04-15T06:01:00.000Z',
      '{}',
    );
    db.prepare(
      `
      INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, completed_at_utc, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'research',
      'opportunity',
      '3',
      'published',
      'system',
      '2026-04-15T06:02:00.000Z',
      '2026-04-15T06:03:00.000Z',
      '{}',
    );
    db.prepare(
      `
      INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, completed_at_utc, error, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'research',
      'opportunity',
      '4',
      'error',
      'system',
      '2026-04-15T06:04:00.000Z',
      '2026-04-15T06:05:00.000Z',
      'boom',
      '{}',
    );

    expect(getCounts().runs_pending).toBe(2);
  });

  it('refreshes mutable source provenance when an existing item is re-ingested', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { upsertSourceItem } = await import('./queries.ts');

    const db = getDb();
    initSchema(db);
    const base = {
      source: 'reddit',
      external_id: 't3_example',
      text: 'same text',
      title: 'Example',
      timestamp_utc: '2026-08-02T10:00:00.000Z',
      content_hash: 'hash',
      sensitivity: 'normal',
    };

    upsertSourceItem({
      ...base,
      canonical_url: null,
      channel_or_label: 'r/combined+feed',
      raw_path: '/tmp/combined.json',
      metadata_json: { subreddit: 'r/combined+feed' },
    });
    upsertSourceItem({
      ...base,
      canonical_url: 'https://old.reddit.com/r/productivity/comments/example/post/',
      channel_or_label: 'r/productivity',
      raw_path: '/tmp/productivity.json',
      metadata_json: { subreddit: 'r/productivity' },
    });

    const row = db.prepare(`
      SELECT canonical_url, channel_or_label, raw_path,
             json_extract(metadata_json, '$.subreddit') subreddit
      FROM source_items WHERE source = 'reddit' AND external_id = 't3_example'
    `).get();
    expect(row).toEqual({
      canonical_url: 'https://old.reddit.com/r/productivity/comments/example/post/',
      channel_or_label: 'r/productivity',
      raw_path: '/tmp/productivity.json',
      subreddit: 'r/productivity',
    });
  });

  it('keeps hypothesis-research originals out of the legacy extraction feed', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { getUnprocessedItems, upsertSourceItem } = await import('./queries.ts');

    const db = getDb();
    initSchema(db);
    const base = {
      external_id: 'source-v1',
      text: 'Synthetic page content for a research workflow test.',
      timestamp_utc: '2026-08-02T10:00:00.000Z',
      raw_path: '',
      content_hash: 'synthetic-hash',
    };
    upsertSourceItem({
      ...base,
      source: 'research_public_web',
      canonical_url: 'https://example.com/research',
      channel_or_label: 'hypothesis-research',
      metadata_json: { workflow: 'hypothesis_research' },
    });
    upsertSourceItem({
      ...base,
      external_id: 'legacy-source-v1',
      source: 'reddit',
      canonical_url: 'https://example.com/legacy',
      metadata_json: { harvest_score: 1 },
    });
    upsertSourceItem({
      ...base,
      external_id: 'explicit-legacy-workflow-v1',
      source: 'public_web',
      canonical_url: 'https://example.com/legacy-workflow',
      metadata_json: { workflow: 'legacy' },
    });

    expect(getUnprocessedItems().map((item) => item.external_id).sort()).toEqual([
      'explicit-legacy-workflow-v1',
      'legacy-source-v1',
    ]);
  });

  it('rolls back all app-state writes when one write fails', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { getAppState, setAppState, setAppStates } = await import('./queries.ts');

    const db = getDb();
    initSchema(db);
    setAppState('reddit_harvest_cursor', 2);
    db.exec(`
      CREATE TRIGGER fail_reddit_harvest_summary
      BEFORE INSERT ON app_state
      WHEN NEW.key = 'reddit_last_harvest_summary'
      BEGIN
        SELECT RAISE(ABORT, 'summary write failed');
      END
    `);

    expect(() => setAppStates({
      reddit_harvest_cursor: 3,
      reddit_last_harvest: '2026-08-02T10:00:00.000Z',
      reddit_last_harvest_summary: { next_cursor: 3 },
    })).toThrow('summary write failed');
    expect(getAppState('reddit_harvest_cursor')).toBe(2);
    expect(getAppState('reddit_last_harvest')).toBeNull();
    expect(getAppState('reddit_last_harvest_summary')).toBeNull();
  });
});
