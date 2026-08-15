import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildMultiSubredditPath,
  buildRedditRssUrl,
  getRedditRetryDelayMs,
  parseRedditAtomEntryUrl,
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
    expect(getRedditRetryDelayMs(new Headers({ 'x-ratelimit-reset': '45' }))).toBe(47_000);
    expect(getRedditRetryDelayMs(new Headers({ 'retry-after': '120' }))).toBe(122_000);
  });

  it('rejects server delay magnitudes that cannot be represented safely', () => {
    expect(getRedditRetryDelayMs(new Headers({ 'retry-after': '9007199254741' }))).toBe(5_000);
  });

  it('waits for the longer server-directed delay when both headers are valid', () => {
    const headers = new Headers({
      'retry-after': '5',
      'x-ratelimit-reset': '45',
    });

    expect(getRedditRetryDelayMs(headers)).toBe(47_000);
  });

  it('supports Retry-After HTTP dates with a safety buffer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T10:00:00.000Z'));

    const headers = new Headers({
      'retry-after': 'Sun, 02 Aug 2026 10:02:00 GMT',
    });
    expect(getRedditRetryDelayMs(headers)).toBe(122_000);
  });
});
