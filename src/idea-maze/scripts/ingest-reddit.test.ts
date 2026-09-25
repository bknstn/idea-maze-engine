import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function atomEntry(id: string, published: string, author?: string): string {
  const authorXml = author ? `<author><name>${author}</name></author>` : '';
  return `<entry><id>t3_${id}</id><title>Post ${id}</title><content type="html">Specific workarounds keep appearing</content><published>${published}</published>${authorXml}<link rel="alternate" href="https://www.reddit.com/r/smallbusiness/comments/${id}/post/"/></entry>`;
}

const successfulFeed = `<feed>${atomEntry('aa1', '2026-09-24T12:00:00Z')}${atomEntry('ab2', '2026-09-24T12:00:00Z', 'writer')}</feed>`;

describe('Reddit ingest persistence and fairness', () => {
  let ideaMazeHome: string;

  beforeEach(() => {
    ideaMazeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-reddit-'));
    fs.mkdirSync(path.join(ideaMazeHome, 'data'), { recursive: true });
    process.env.IDEA_MAZE_HOME = ideaMazeHome;
    vi.resetModules();
  });

  afterEach(async () => {
    const dbModule = await import('./lib/db.ts');
    dbModule.closeDb();
    delete process.env.IDEA_MAZE_HOME;
    fs.rmSync(ideaMazeHome, { recursive: true, force: true });
  });

  async function initialize(configured: unknown[]) {
    const { getDb } = await import('./lib/db.ts');
    const { initSchema } = await import('./lib/schema.ts');
    const { setAppState } = await import('./lib/queries.ts');
    const db = getDb();
    initSchema(db);
    setAppState('reddit_subreddits', configured);
    const { getAppState } = await import('./lib/queries.ts');
    return { db, getDb, setAppState, getAppState };
  }

  it('overlaps repeated runs, deduplicates rows, preserves gaps, and adds JSON status', async () => {
    const { getDb, setAppState } = await initialize(['smallbusiness']);
    setAppState('reddit_harvest_state', {
      smallbusiness: {
        last_success_at_utc: '2026-09-20T12:00:00.000Z',
        cursor_timestamp_utc: '2026-09-20T11:00:00.000Z',
        cursor_post_id: 'old01',
      },
    });
    const { main } = await import('./ingest-reddit.ts');
    let now = new Date('2026-09-24T12:00:00.000Z');
    let responseNumber = 0;
    const recoveredDepthFeed = `<feed>${atomEntry('old00', '2026-09-24T10:00:00Z')}${atomEntry('aa1', '2026-09-24T12:00:00Z')}${atomEntry('ab2', '2026-09-24T12:00:00Z', 'writer')}</feed>`;
    const fetchImpl = vi.fn(async () => new Response(responseNumber++ < 2 ? successfulFeed : recoveredDepthFeed));
    const options = {
      fetchImpl,
      now: () => now,
      dataDir: path.join(ideaMazeHome, 'data'),
      log: () => undefined,
      requestBudgetMs: 30_000,
      requestTimeoutMs: 5_000,
    };

    const first = await main(options);
    expect(first.subreddits[0].requested_start_utc).toBe('2026-09-20T11:00:00.000Z');
    expect(first.subreddits[0]).toMatchObject({ status: 'possible_gap', last_range_coverage_state: 'possible_gap', fetched_count: 2, new_count: 2 });
    expect((await import('./ingest-reddit.ts')).redditHarvestExitCode(first)).toBe(0);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM source_items WHERE source = 'reddit'").get()).toEqual({ count: 2 });
    expect(getDb().prepare("SELECT author FROM source_items WHERE external_id = 't3_aa1'").get()).toEqual({ author: null });

    now = new Date('2026-09-24T12:05:00.000Z');
    const second = await main(options);
    expect(second.subreddits[0]).toMatchObject({ status: 'possible_gap', fetched_count: 2, new_count: 0, updated_count: 2, changed_count: 0, unchanged_count: 2 });
    now = new Date('2026-09-24T12:10:00.000Z');
    const third = await main(options);
    expect(third.subreddits[0]).toMatchObject({ status: 'possible_gap', last_range_coverage_state: 'covered' });
    const state = (await import('./lib/queries.ts')).getAppState('reddit_harvest_state');
    expect(state.smallbusiness).toMatchObject({
      last_success_at_utc: '2026-09-24T12:10:00.000Z',
      cursor_timestamp_utc: '2026-09-24T12:00:00.000Z',
      cursor_post_id: 'ab2',
      coverage_state: 'possible_gap',
      last_range_coverage_state: 'covered',
    });
    expect(state.smallbusiness.coverage_gaps).toHaveLength(2);
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM source_items WHERE source = 'reddit'").get()).toEqual({ count: 2 });

    const legacySummary = (await import('./lib/queries.ts')).getAppState('reddit_last_harvest_summary');
    expect(legacySummary).toMatchObject({
      configured_count: 1,
      selected_subreddits: ['smallbusiness'],
      fetched_count: 2,
      new_count: 0,
      updated_count: 2,
      changed_count: 0,
      unchanged_count: 2,
    });
    const { buildPipelineStatusSnapshot } = await import('./lib/observability.ts');
    const snapshot = buildPipelineStatusSnapshot(getDb(), new Date('2026-09-24T12:10:00.000Z'));
    expect(snapshot.reddit_harvest.subreddits[0]).toMatchObject({
      subreddit: 'smallbusiness',
      current_run_status: 'possible_gap',
      freshness_seconds: 0,
      coverage_state: 'possible_gap',
      last_range_coverage_state: 'covered',
    });
    expect(snapshot.reddit_harvest.coverage_gaps[0]).toMatchObject({
      reason: 'rss_depth_did_not_reach_requested_start',
      subreddit: 'smallbusiness',
    });
  });

  it('keeps empty feeds and unattempted configured subreddits visible without advancing success', async () => {
    const { getDb } = await initialize(['quiet', 'active']);
    const { main } = await import('./ingest-reddit.ts');
    const run = await main({
      fetchImpl: async () => new Response('<feed></feed>'),
      now: () => new Date('2026-09-24T12:00:00.000Z'),
      dataDir: path.join(ideaMazeHome, 'data'),
      maxSubredditsPerRun: 1,
      log: () => undefined,
    });
    expect(run.subreddits[0].status).toBe('empty_unverified');
    const { redditHarvestExitCode } = await import('./ingest-reddit.ts');
    expect(redditHarvestExitCode(run)).toBe(1);
    expect(run.deferred_subreddits).toEqual([{ subreddit: 'active', reason: 'rotation_batch_limit' }]);
    const queries = await import('./lib/queries.ts');
    expect(queries.getAppState('reddit_last_harvest')).toBeNull();
    const { buildRedditHarvestStatusSnapshot } = await import('./lib/observability.ts');
    const status = buildRedditHarvestStatusSnapshot(getDb(), new Date('2026-09-24T12:01:00.000Z'));
    expect(status.subreddits).toEqual(expect.arrayContaining([
      expect.objectContaining({ subreddit: 'quiet', current_run_status: 'empty_unverified', freshness_seconds: null }),
      expect.objectContaining({ subreddit: 'active', current_run_status: 'deferred', deferred_reason: 'rotation_batch_limit' }),
    ]));
    expect(status.coverage_gaps[0]).toMatchObject({ reason: 'empty_feed_unverified', subreddit: 'quiet' });
  });

  it('stops the run after a global 429 and advances fairness by one attempted feed', async () => {
    const { getAppState } = await initialize(['first', 'second', 'third']);
    const { main } = await import('./ingest-reddit.ts');
    const fetchImpl = vi.fn(async () => new Response('limited', { status: 429, headers: { 'Retry-After': '0' } }));
    const run = await main({
      fetchImpl,
      sleep: async () => undefined,
      now: () => new Date('2026-09-24T12:00:00.000Z'),
      dataDir: path.join(ideaMazeHome, 'data'),
      maxSubredditsPerRun: 3,
      log: () => undefined,
    });
    const { redditHarvestExitCode } = await import('./ingest-reddit.ts');
    expect(redditHarvestExitCode(run)).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(run.subreddits).toHaveLength(1);
    expect(run.subreddits[0]).toMatchObject({ status: 'rate_limited', failure_class: 'rate_limit', attempts: 2 });
    expect(run.deferred_subreddits).toEqual([
      { subreddit: 'second', reason: 'global_rate_limit' },
      { subreddit: 'third', reason: 'global_rate_limit' },
    ]);
    expect(run.next_cursor).toBe(1);
    expect(getAppState('reddit_last_harvest')).toBeNull();
  });

  it('does not advance a subreddit cursor when source persistence fails', async () => {
    const { db, getDb } = await initialize(['smallbusiness']);
    db.exec(`CREATE TRIGGER fail_second_reddit_item BEFORE INSERT ON source_items WHEN NEW.external_id = 't3_ab2' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`);
    const { main } = await import('./ingest-reddit.ts');
    const run = await main({
      fetchImpl: async () => new Response(successfulFeed),
      now: () => new Date('2026-09-24T12:00:00.000Z'),
      dataDir: path.join(ideaMazeHome, 'data'),
      log: () => undefined,
    });
    const state = (await import('./lib/queries.ts')).getAppState('reddit_harvest_state');
    expect(run.subreddits[0]).toMatchObject({ status: 'persistence_error', failure_class: 'persistence_error' });
    expect(run.subreddits[0].coverage_gap).toMatchObject({
      reason: 'persistence_error',
      certainty: 'unobserved',
    });
    expect(state.smallbusiness.last_success_at_utc).toBeNull();
    expect(state.smallbusiness.cursor_post_id).toBeNull();
    expect(state.smallbusiness.last_failure).toMatchObject({ failure_class: 'persistence_error' });
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM source_items WHERE source = 'reddit'").get()).toEqual({ count: 0 });
  });

  it('does not save database rows or cursors when an atomic raw-file write fails', async () => {
    const { getDb } = await initialize(['smallbusiness']);
    const blockedDataPath = path.join(ideaMazeHome, 'raw-path-is-a-file');
    fs.writeFileSync(blockedDataPath, 'blocker');
    const { main } = await import('./ingest-reddit.ts');
    const run = await main({
      fetchImpl: async () => new Response(successfulFeed),
      now: () => new Date('2026-09-24T12:00:00.000Z'),
      dataDir: blockedDataPath,
      log: () => undefined,
    });
    const state = (await import('./lib/queries.ts')).getAppState('reddit_harvest_state');
    expect(run.subreddits[0].status).toBe('persistence_error');
    expect(state.smallbusiness.last_success_at_utc).toBeNull();
    expect(state.smallbusiness.cursor_post_id).toBeNull();
    expect(getDb().prepare("SELECT COUNT(*) AS count FROM source_items WHERE source = 'reddit'").get()).toEqual({ count: 0 });
  });
});
