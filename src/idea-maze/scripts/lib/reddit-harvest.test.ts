import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMultiSubredditPath,
  buildRedditRssUrl,
  assessRedditCoverage,
  extractRedditPostId,
  fetchRedditAtomFeed,
  getRedditRetryDelayMs,
  normalizeRedditSubreddits,
  parseRedditAtomFeed,
  parseRedditAtomEntryUrl,
  selectRedditHarvestBatch,
  selectRedditHarvestShard,
  sleepWithSafeTimeout,
  subredditFromEntryUrl,
} from './reddit-harvest.ts';

describe('selectRedditHarvestShard', () => {
  it('spreads ordered subreddit configuration across rotating shards', () => {
    const configured = Array.from({ length: 27 }, (_, index) => `sub-${index}`);

    const first = selectRedditHarvestShard(configured, 0, 6);
    const second = selectRedditHarvestShard(configured, first.nextCursor, 6);

    expect(first.selected).toEqual(['sub-0', 'sub-5', 'sub-10', 'sub-15', 'sub-20', 'sub-25']);
    expect(first.shardCount).toBe(5);
    expect(first.nextCursor).toBe(1);
    expect(second.selected).toEqual(['sub-1', 'sub-6', 'sub-11', 'sub-16', 'sub-21', 'sub-26']);
  });

  it('covers every configured subreddit once per complete rotation', () => {
    const configured = Array.from({ length: 27 }, (_, index) => `sub-${index}`);
    const seen: string[] = [];
    let cursor = 0;

    for (let run = 0; run < 5; run += 1) {
      const shard = selectRedditHarvestShard(configured, cursor, 6);
      seen.push(...shard.selected);
      cursor = shard.nextCursor;
    }

    expect(new Set(seen)).toEqual(new Set(configured));
    expect(seen).toHaveLength(configured.length);
    expect(cursor).toBe(0);
  });
});

describe('Reddit multi-feed helpers', () => {
  it('builds one multi-subreddit path from a selected shard', () => {
    expect(buildMultiSubredditPath(['smallbusiness', 'OuraRing', 'onebag'])).toBe('smallbusiness+OuraRing+onebag');
  });

  it('uses the working Reddit host for Atom feeds', () => {
    expect(buildRedditRssUrl('smallbusiness+marketing')).toBe(
      'https://www.reddit.com/r/smallbusiness+marketing/new/.rss',
    );
  });

  it('extracts alternate Atom links regardless of attribute order', () => {
    expect(
      parseRedditAtomEntryUrl('<link href="https://www.reddit.com/r/productivity/comments/abc/example/" rel="alternate"/>'),
    ).toBe('https://www.reddit.com/r/productivity/comments/abc/example/');
    expect(
      parseRedditAtomEntryUrl('<link rel="alternate" type="text/html" href="https://www.reddit.com/r/Anki/comments/def/example/"/>'),
    ).toBe('https://www.reddit.com/r/Anki/comments/def/example/');
    expect(
      parseRedditAtomEntryUrl('<link href="https://www.reddit.com/r/GetStudying/comments/ghi/example/"/>'),
    ).toBe('https://www.reddit.com/r/GetStudying/comments/ghi/example/');
  });

  it('derives the actual subreddit from an RSS entry URL', () => {
    expect(subredditFromEntryUrl('https://www.reddit.com/r/Anki/comments/abc123/example/')).toBe('Anki');
    expect(subredditFromEntryUrl('https://www.reddit.com/comments/abc123/example/')).toBeNull();
    expect(subredditFromEntryUrl('https://old.reddit.com/r/foo+bar/new/.rss')).toBeNull();
    expect(subredditFromEntryUrl(null)).toBeNull();
  });
});

function atomEntry(id: string, published: string, subreddit = 'smallbusiness'): string {
  return `<entry><id>t3_${id}</id><title>Post ${id}</title><content type="html">A useful &amp; real signal</content><published>${published}</published><link rel="alternate" href="https://www.reddit.com/r/${subreddit}/comments/${id}/post/"/></entry>`;
}

describe('per-subreddit harvesting', () => {
  it('normalizes configuration and rotates through all quiet sources fairly', () => {
    expect(normalizeRedditSubreddits(['SaaS', ' saas ', 'startups', 'bad/name', 3])).toEqual({
      valid: ['SaaS', 'startups'],
      invalid: ['bad/name', '3'],
    });
    const configured = ['a', 'b', 'c', 'd', 'e'];
    const first = selectRedditHarvestBatch(configured, 0, 2);
    const second = selectRedditHarvestBatch(configured, first.nextCursor, 2);
    const third = selectRedditHarvestBatch(configured, second.nextCursor, 2);
    expect([...first.selected, ...second.selected, ...third.selected]).toEqual(configured);
    expect(first.deferred).toEqual(['c', 'd', 'e']);
  });

  it('parses posts with equal timestamps as separate cursor candidates', () => {
    const xml = `<feed>${atomEntry('abc', '2026-09-24T12:00:00Z')}${atomEntry('def', '2026-09-24T12:00:00Z')}</feed>`;
    const parsed = parseRedditAtomFeed(xml);
    expect(parsed.error).toBeNull();
    expect(parsed.entries.map((entry) => entry.postId)).toEqual(['abc', 'def']);
    expect(parsed.entries.map((entry) => entry.timestampUtc)).toEqual([
      '2026-09-24T12:00:00.000Z',
      '2026-09-24T12:00:00.000Z',
    ]);
    expect(extractRedditPostId('t3_abc', null)).toBe('abc');
  });

  it('distinguishes an empty valid feed from malformed XML and malformed entries', async () => {
    const empty = await fetchRedditAtomFeed('smallbusiness', {
      fetchImpl: async () => new Response('<feed></feed>'),
      sleep: async () => undefined,
    });
    const malformed = await fetchRedditAtomFeed('smallbusiness', {
      fetchImpl: async () => new Response('<html>blocked</html>'),
      sleep: async () => undefined,
    });
    const partial = await fetchRedditAtomFeed('smallbusiness', {
      fetchImpl: async () => new Response(`<feed>${atomEntry('ok1', '2026-09-24T12:00:00Z')}<entry><id>broken</id></entry></feed>`),
      sleep: async () => undefined,
    });
    expect(empty.status).toBe('empty');
    expect(malformed).toMatchObject({ status: 'failed', failureClass: 'parse_error' });
    expect(partial).toMatchObject({ status: 'partial', invalidEntryCount: 1, entries: [{ postId: 'ok1' }] });
  });

  it('counts unmatched Atom entries and rejects links outside the requested subreddit', async () => {
    const unmatched = parseRedditAtomFeed(`<feed>${atomEntry('ok1', '2026-09-24T12:00:00Z')}<entry><id>t3_broken</id></feed>`);
    const wrongSubreddit = await fetchRedditAtomFeed('smallbusiness', {
      fetchImpl: async () => new Response(`<feed>${atomEntry('ok1', '2026-09-24T12:00:00Z', 'startups')}</feed>`),
      sleep: async () => undefined,
    });
    expect(unmatched.invalidEntryCount).toBe(1);
    expect(wrongSubreddit).toMatchObject({ status: 'partial', invalidEntryCount: 1, entries: [] });
  });

  it('defers a 429 when Retry-After exceeds the bounded retry window', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '120' } }))
      .mockResolvedValueOnce(new Response(`<feed>${atomEntry('ok1', '2026-09-24T12:00:00Z')}</feed>`));
    const sleep = vi.fn(async () => undefined);
    const result = await fetchRedditAtomFeed('smallbusiness', {
      fetchImpl,
      sleep,
      now: () => Date.parse('2026-09-24T12:00:00Z'),
    });
    expect(result).toMatchObject({ status: 'rate_limited', attempts: 1, failureClass: 'rate_limit' });
    expect(result.error).toBe('reddit_retry_deferred_by_cap');
    expect(result.retryAfterMs).toBe(122_000);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 429 after a bounded server delay that fits the retry window', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '5' } }))
      .mockResolvedValueOnce(new Response(`<feed>${atomEntry('ok1', '2026-09-24T12:00:00Z')}</feed>`));
    const sleep = vi.fn(async () => undefined);
    const result = await fetchRedditAtomFeed('smallbusiness', {
      fetchImpl,
      sleep,
      now: () => Date.parse('2026-09-24T12:00:00Z'),
    });
    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(7_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After on retryable 503 responses', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status: 503, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(new Response(`<feed>${atomEntry('ok1', '2026-09-24T12:00:00Z')}</feed>`));
    const sleep = vi.fn(async () => undefined);
    const result = await fetchRedditAtomFeed('smallbusiness', {
      fetchImpl,
      sleep,
      now: () => Date.parse('2026-09-24T12:00:00Z'),
    });
    expect(result).toMatchObject({ status: 'ok', attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(4_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a timed out request once within the attempt limit', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(new Response(`<feed>${atomEntry('ok1', '2026-09-24T12:00:00Z')}</feed>`));
    const sleep = vi.fn(async () => undefined);
    const result = await fetchRedditAtomFeed('smallbusiness', { fetchImpl, sleep });
    expect(result).toMatchObject({ status: 'ok', attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('does not retry before Retry-After when the run budget cannot fit the wait', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '5' } }));
    const sleep = vi.fn(async () => undefined);
    const result = await fetchRedditAtomFeed('smallbusiness', {
      fetchImpl,
      sleep,
      now: () => 1_000,
      deadlineMs: 8_000,
    });
    expect(result).toMatchObject({ status: 'rate_limited', attempts: 1 });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports possible gaps when a finite feed does not reach the requested start', () => {
    const parsed = parseRedditAtomFeed(`<feed>${atomEntry('recent', '2026-09-24T12:00:00Z')}</feed>`);
    const result = assessRedditCoverage({
      requestedStartUtc: '2026-09-24T10:00:00.000Z',
      requestedEndUtc: '2026-09-24T12:01:00.000Z',
      observedAtUtc: '2026-09-24T12:01:00.000Z',
      entries: parsed.entries,
      feedStatus: 'ok',
      truncated: false,
    });
    expect(result.coverageState).toBe('possible_gap');
    expect(result.gap).toMatchObject({
      reason: 'rss_depth_did_not_reach_requested_start',
      certainty: 'possible',
      oldest_seen_post_id: 'recent',
    });
  });

  it('reports local feed truncation explicitly', () => {
    const parsed = parseRedditAtomFeed(`<feed>${atomEntry('one', '2026-09-24T12:00:00Z')}${atomEntry('two', '2026-09-24T11:00:00Z')}</feed>`, 1);
    expect(parsed.truncated).toBe(true);
    expect(parsed.entries.map((entry) => entry.postId)).toEqual(['one']);
  });
});

describe('sleepWithSafeTimeout', () => {
  it('chunks waits longer than the maximum Node timer delay', async () => {
    const scheduledDelays: number[] = [];
    const schedule = (callback: () => void, delayMs: number) => {
      scheduledDelays.push(delayMs);
      callback();
    };

    await sleepWithSafeTimeout(2_147_483_647 * 2 + 25, schedule);

    expect(scheduledDelays).toEqual([2_147_483_647, 2_147_483_647, 25]);
  });

  it('rejects unsupported delay magnitudes instead of scheduling them', async () => {
    const schedule = vi.fn();

    await expect(sleepWithSafeTimeout(Number.NaN, schedule)).rejects.toThrow('safe non-negative integer');
    await expect(sleepWithSafeTimeout(Number.MAX_SAFE_INTEGER + 1, schedule)).rejects.toThrow(
      'safe non-negative integer',
    );
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe('getRedditRetryDelayMs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('honors long server-directed delays with a safety buffer', () => {
    expect(getRedditRetryDelayMs(new Headers({ 'x-ratelimit-reset': '45' }))).toBe(30_000);
    expect(getRedditRetryDelayMs(new Headers({ 'retry-after': '120' }))).toBe(30_000);
  });

  it('rejects server delay magnitudes that cannot be represented safely', () => {
    expect(getRedditRetryDelayMs(new Headers({ 'retry-after': '9007199254741' }))).toBe(5_000);
  });

  it('waits for the longer server-directed delay when both headers are valid', () => {
    const headers = new Headers({
      'retry-after': '5',
      'x-ratelimit-reset': '45',
    });

    expect(getRedditRetryDelayMs(headers)).toBe(30_000);
  });

  it('supports Retry-After HTTP dates with a safety buffer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'));

    const headers = new Headers({
      'retry-after': 'Sun, 02 Aug 2026 10:02:00 GMT',
    });
    expect(getRedditRetryDelayMs(headers)).toBe(30_000);
  });

  it('accepts a tighter caller cap', () => {
    expect(getRedditRetryDelayMs(new Headers({ 'retry-after': '10' }), 4_000)).toBe(4_000);
  });
});
