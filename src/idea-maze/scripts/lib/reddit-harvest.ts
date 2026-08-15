export interface RedditHarvestShard {
  selected: string[];
  cursor: number;
  nextCursor: number;
  shardCount: number;
}

const DEFAULT_RETRY_DELAY_MS = 5_000;
const RETRY_DELAY_SAFETY_BUFFER_MS = 2_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SUBREDDIT_NAME = /^[A-Za-z0-9_]+$/;

type TimerScheduler = (callback: () => void, delayMs: number) => unknown;

export async function sleepWithSafeTimeout(
  delayMs: number,
  schedule: TimerScheduler = setTimeout,
): Promise<void> {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
    throw new Error('Retry delay must be a safe non-negative integer.');
  }

  let remainingMs = delayMs;
  while (remainingMs > 0) {
    const chunkMs = Math.min(remainingMs, MAX_TIMER_DELAY_MS);
    await new Promise<void>((resolveSleep) => schedule(resolveSleep, chunkMs));
    remainingMs -= chunkMs;
  }
}

export function selectRedditHarvestShard(
  configured: string[],
  cursor: number,
  batchSize: number,
): RedditHarvestShard {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('Reddit harvest batch size must be a positive integer.');
  }

  const unique = [...new Set(configured.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return { selected: [], cursor: 0, nextCursor: 0, shardCount: 0 };
  }

  const shardCount = Math.ceil(unique.length / batchSize);
  const normalizedCursor = ((Math.trunc(cursor) % shardCount) + shardCount) % shardCount;
  const selected = unique.filter((_value, index) => index % shardCount === normalizedCursor);

  return {
    selected,
    cursor: normalizedCursor,
    nextCursor: (normalizedCursor + 1) % shardCount,
    shardCount,
  };
}

export function buildMultiSubredditPath(subreddits: string[]): string {
  if (subreddits.length === 0) {
    throw new Error('Cannot build a Reddit multi-feed without subreddits.');
  }
  for (const subreddit of subreddits) {
    if (!SUBREDDIT_NAME.test(subreddit)) {
      throw new Error(`Invalid subreddit name: ${subreddit}`);
    }
  }
  return subreddits.join('+');
}

export function buildRedditRssUrl(subredditPath: string): string {
  return `https://www.reddit.com/r/${subredditPath}/new/.rss`;
}

export function parseRedditAtomEntryUrl(entryXml: string): string | null {
  const linkTags = entryXml.match(/<link\b[^>]*>/gi) ?? [];
  let fallback: string | null = null;
  for (const linkTag of linkTags) {
    const href = linkTag.match(/\bhref=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, '&') ?? null;
    if (!href) continue;
    if (/\brel=["']alternate["']/i.test(linkTag)) return href;
    fallback ??= href;
  }
  return fallback;
}

export function subredditFromEntryUrl(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/\/r\/([A-Za-z0-9_]+)(?:\/|$)/i);
  return match?.[1] ?? null;
}

function parseSecondsAsMilliseconds(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = Math.ceil(seconds * 1_000);
  return Number.isSafeInteger(milliseconds)
    && milliseconds <= Number.MAX_SAFE_INTEGER - RETRY_DELAY_SAFETY_BUFFER_MS
    ? milliseconds
    : null;
}

export function getRedditRetryDelayMs(headers: Headers): number {
  const retryAfterRaw = headers.get('retry-after');
  const retryAfterSecondsMs = parseSecondsAsMilliseconds(retryAfterRaw);
  const retryAfterDate = retryAfterSecondsMs === null && retryAfterRaw
    ? Date.parse(retryAfterRaw)
    : Number.NaN;
  const retryAfterMs = retryAfterSecondsMs !== null
    ? retryAfterSecondsMs
    : Number.isFinite(retryAfterDate)
      ? Math.max(0, retryAfterDate - Date.now())
      : null;
  const rateLimitResetMs = parseSecondsAsMilliseconds(headers.get('x-ratelimit-reset'));
  const serverDelaysMs = [retryAfterMs, rateLimitResetMs].filter(
    (delay): delay is number => delay !== null,
  );
  if (serverDelaysMs.length === 0) return DEFAULT_RETRY_DELAY_MS;
  return Math.max(...serverDelaysMs) + RETRY_DELAY_SAFETY_BUFFER_MS;
}
