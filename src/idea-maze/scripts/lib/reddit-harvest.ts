export interface RedditHarvestShard {
  selected: string[];
  cursor: number;
  nextCursor: number;
  shardCount: number;
}

export interface RedditHarvestBatch extends RedditHarvestShard {
  configured: string[];
  deferred: string[];
}

export interface RedditAtomEntry {
  id: string;
  title: string;
  text: string;
  author: string | null;
  url: string;
  published: string;
  timestampUtc: string;
  postId: string;
  subreddit: string;
}

export interface ParsedRedditFeed {
  entries: RedditAtomEntry[];
  invalidEntryCount: number;
  truncated: boolean;
  error: string | null;
}

export interface RedditFeedFetchResult {
  status: 'ok' | 'empty' | 'partial' | 'failed' | 'rate_limited' | 'budget_exhausted';
  entries: RedditAtomEntry[];
  invalidEntryCount: number;
  truncated: boolean;
  attempts: number;
  error: string | null;
  failureClass: string | null;
  retryAfterMs: number | null;
}

export interface FetchRedditFeedOptions {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayCapMs?: number;
  deadlineMs?: number;
  maxEntries?: number;
}

export interface RedditCoverageGap {
  observed_at_utc: string;
  requested_start_utc: string;
  requested_end_utc: string;
  reason: string;
  certainty: 'possible' | 'unobserved';
  oldest_seen_at_utc?: string;
  oldest_seen_post_id?: string;
}

export interface RedditCoverageAssessment {
  coverageState: 'covered' | 'possible_gap' | 'empty_unverified' | 'truncated' | 'partial';
  gap: RedditCoverageGap | null;
}

const DEFAULT_RETRY_DELAY_MS = 5_000;
const RETRY_DELAY_SAFETY_BUFFER_MS = 2_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_CAP_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 50;
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
  if (unique.length === 0) return { selected: [], cursor: 0, nextCursor: 0, shardCount: 0 };
  const shardCount = Math.ceil(unique.length / batchSize);
  const normalizedCursor = ((Math.trunc(cursor) % shardCount) + shardCount) % shardCount;
  const selected = unique.filter((_value, index) => index % shardCount === normalizedCursor);
  return { selected, cursor: normalizedCursor, nextCursor: (normalizedCursor + 1) % shardCount, shardCount };
}

export function normalizeRedditSubreddits(configured: unknown): { valid: string[]; invalid: string[] } {
  if (!Array.isArray(configured)) return { valid: [], invalid: [] };
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const value of configured) {
    if (typeof value !== 'string') {
      invalid.push(String(value));
      continue;
    }
    const subreddit = value.trim();
    if (!subreddit) continue;
    if (!SUBREDDIT_NAME.test(subreddit)) {
      invalid.push(subreddit);
      continue;
    }
    const key = subreddit.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(subreddit);
  }
  return { valid, invalid };
}

export function selectRedditHarvestBatch(configured: string[], cursor: number, batchSize: number): RedditHarvestBatch {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error('Reddit harvest batch size must be a positive integer.');
  }
  const unique = [...new Set(configured.map((value) => value.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return { configured: [], selected: [], deferred: [], cursor: 0, nextCursor: 0, shardCount: 0 };
  }
  const normalizedCursor = ((Math.trunc(cursor) % unique.length) + unique.length) % unique.length;
  const selected = unique.slice(normalizedCursor, normalizedCursor + batchSize);
  const selectedSet = new Set(selected);
  return {
    configured: unique,
    selected,
    deferred: unique.filter((subreddit) => !selectedSet.has(subreddit)),
    cursor: normalizedCursor,
    nextCursor: normalizedCursor + selected.length >= unique.length ? 0 : normalizedCursor + selected.length,
    shardCount: Math.ceil(unique.length / batchSize),
  };
}

export function nextRedditHarvestCursor(configuredCount: number, cursor: number, attemptedCount: number): number {
  if (configuredCount <= 0) return 0;
  const normalizedCursor = ((Math.trunc(cursor) % configuredCount) + configuredCount) % configuredCount;
  return (normalizedCursor + Math.max(0, Math.trunc(attemptedCount))) % configuredCount;
}

export function buildMultiSubredditPath(subreddits: string[]): string {
  if (subreddits.length === 0) throw new Error('Cannot build a Reddit multi-feed without subreddits.');
  for (const subreddit of subreddits) {
    if (!SUBREDDIT_NAME.test(subreddit)) throw new Error(`Invalid subreddit name: ${subreddit}`);
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
  return url.match(/\/r\/([A-Za-z0-9_]+)(?:\/|$)/i)?.[1] ?? null;
}

export function extractRedditPostId(atomId: string, url: string | null): string | null {
  for (const value of [atomId, url ?? '']) {
    const trimmed = value.replace(/\/+$/, '');
    if (trimmed.includes('comments/')) {
      const candidate = trimmed.split('comments/')[1].split('/')[0];
      if (/^[A-Za-z0-9]+$/.test(candidate)) return candidate;
    }
    if (trimmed.startsWith('t3_') && /^[A-Za-z0-9]+$/.test(trimmed.slice(3))) return trimmed.slice(3);
  }
  return null;
}

function decodeXmlEntities(value: string): string {
  const decodeCodePoint = (raw: string, radix: number) => {
    const codePoint = Number.parseInt(raw, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : '\uFFFD';
  };
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => decodeCodePoint(hex, 16))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => decodeCodePoint(decimal, 10))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function tagText(block: string, name: string): string {
  const match = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? decodeXmlEntities(match[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
}

function isCanonicalRedditEntryUrl(url: string, subreddit: string, postId: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !['reddit.com', 'www.reddit.com', 'old.reddit.com'].includes(parsed.hostname.toLowerCase())) {
      return false;
    }
    const match = parsed.pathname.match(/^\/r\/([A-Za-z0-9_]+)\/comments\/([A-Za-z0-9]+)(?:\/|$)/i);
    return Boolean(match
      && match[1].toLowerCase() === subreddit.toLowerCase()
      && match[2].toLowerCase() === postId.toLowerCase());
  } catch {
    return false;
  }
}

export function parseRedditAtomFeed(xml: string, maxEntries = DEFAULT_MAX_ENTRIES, expectedSubreddit?: string): ParsedRedditFeed {
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error('Reddit feed entry limit must be a positive integer.');
  const trimmed = xml.trim().replace(/^\uFEFF/, '').replace(/^<\?xml[^>]*>\s*/i, '');
  if (!/^<feed\b[^>]*>/i.test(trimmed) || !/<\/feed\s*>\s*$/i.test(trimmed)) {
    return { entries: [], invalidEntryCount: 0, truncated: false, error: 'malformed_atom_feed' };
  }
  const rawEntries = [...trimmed.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi)];
  const entries: RedditAtomEntry[] = [];
  const seenPostIds = new Set<string>();
  const openingEntryCount = (trimmed.match(/<entry\b/gi) ?? []).length;
  const closingEntryCount = (trimmed.match(/<\/entry\s*>/gi) ?? []).length;
  let invalidEntryCount = Math.max(openingEntryCount - rawEntries.length, closingEntryCount - rawEntries.length, 0);
  for (const match of rawEntries) {
    const block = match[1];
    const id = tagText(block, 'id');
    const title = tagText(block, 'title');
    const published = tagText(block, 'published') || tagText(block, 'updated');
    const url = parseRedditAtomEntryUrl(block);
    const postId = extractRedditPostId(id, url);
    const subreddit = subredditFromEntryUrl(url);
    const timestamp = published ? Date.parse(published) : Number.NaN;
    if (!id || !title || !url || !postId || !subreddit || !Number.isFinite(timestamp)
      || !isCanonicalRedditEntryUrl(url, subreddit, postId)
      || (expectedSubreddit && subreddit.toLowerCase() !== expectedSubreddit.toLowerCase())) {
      invalidEntryCount += 1;
      continue;
    }
    if (seenPostIds.has(postId)) continue;
    seenPostIds.add(postId);
    const contentBlock = block.match(/<(?:content|summary)\b[^>]*>([\s\S]*?)<\/(?:content|summary)>/i)?.[1] ?? '';
    const text = decodeXmlEntities(contentBlock.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() || title;
    const authorMatch = block.match(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name\s*>[\s\S]*?<\/author\s*>/i);
    entries.push({
      id, title, text,
      author: authorMatch ? decodeXmlEntities(authorMatch[1].replace(/<[^>]+>/g, '')).trim() || null : null,
      url, published, timestampUtc: new Date(timestamp).toISOString(), postId, subreddit,
    });
  }
  const truncated = entries.length > maxEntries;
  return { entries: entries.slice(0, maxEntries), invalidEntryCount, truncated, error: null };
}

function parseSecondsAsMilliseconds(raw: string | null): number | null {
  if (!raw) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const milliseconds = Math.ceil(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds <= Number.MAX_SAFE_INTEGER - RETRY_DELAY_SAFETY_BUFFER_MS
    ? milliseconds
    : null;
}

function requestedRetryDelayMs(headers: Headers, nowMs: number): number {
  const retryAfterRaw = headers.get('retry-after');
  const retryAfterSecondsMs = parseSecondsAsMilliseconds(retryAfterRaw);
  if (retryAfterRaw && retryAfterSecondsMs === null && /^\s*\d+(?:\.\d+)?\s*$/.test(retryAfterRaw)) {
    return Number.MAX_SAFE_INTEGER;
  }
  const retryAfterDate = retryAfterSecondsMs === null && retryAfterRaw ? Date.parse(retryAfterRaw) : Number.NaN;
  const retryAfterMs = retryAfterSecondsMs !== null
    ? retryAfterSecondsMs
    : Number.isFinite(retryAfterDate) ? Math.max(0, retryAfterDate - nowMs) : null;
  const rateLimitResetMs = parseSecondsAsMilliseconds(headers.get('x-ratelimit-reset'));
  const serverDelaysMs = [retryAfterMs, rateLimitResetMs].filter((delay): delay is number => delay !== null);
  return (serverDelaysMs.length === 0 ? DEFAULT_RETRY_DELAY_MS : Math.max(...serverDelaysMs))
    + (serverDelaysMs.length === 0 ? 0 : RETRY_DELAY_SAFETY_BUFFER_MS);
}

export function getRedditRetryDelayMs(headers: Headers, maxDelayMs = DEFAULT_RETRY_DELAY_CAP_MS, nowMs = Date.now()): number {
  const rawRetryAfter = headers.get('retry-after');
  if (rawRetryAfter && parseSecondsAsMilliseconds(rawRetryAfter) === null && /^\s*\d+(?:\.\d+)?\s*$/.test(rawRetryAfter)) {
    return Math.min(DEFAULT_RETRY_DELAY_MS, maxDelayMs);
  }
  return Math.max(0, Math.min(requestedRetryDelayMs(headers, nowMs), maxDelayMs));
}

function classifyHttpFailure(status: number): string {
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server_error';
  return 'http_error';
}

export async function fetchRedditAtomFeed(subreddit: string, options: FetchRedditFeedOptions = {}): Promise<RedditFeedFetchResult> {
  if (!SUBREDDIT_NAME.test(subreddit)) {
    return { status: 'failed', entries: [], invalidEntryCount: 0, truncated: false, attempts: 0,
      error: `invalid_subreddit:${subreddit}`, failureClass: 'configuration', retryAfterMs: null };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? sleepWithSafeTimeout;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayCapMs = options.retryDelayCapMs ?? DEFAULT_RETRY_DELAY_CAP_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let attempts = 0;
  let lastRetryAfterMs: number | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingBudgetMs = options.deadlineMs === undefined ? timeoutMs : options.deadlineMs - now();
    if (remainingBudgetMs <= 0) {
      return { status: 'budget_exhausted', entries: [], invalidEntryCount: 0, truncated: false, attempts,
        error: 'reddit_request_budget_exhausted', failureClass: 'budget_exhausted', retryAfterMs: lastRetryAfterMs };
    }
    const requestTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingBudgetMs));
    attempts += 1;
    let response: Response;
    try {
      response = await fetchImpl(buildRedditRssUrl(subreddit), {
        headers: { 'User-Agent': 'idea-maze-engine/1.0', Accept: 'application/atom+xml' },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      const failureClass = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network_error';
      if (attempt < maxAttempts && (failureClass === 'network_error' || failureClass === 'timeout')) {
        const delayMs = Math.min(DEFAULT_RETRY_DELAY_MS, retryDelayCapMs);
        if (options.deadlineMs !== undefined && now() + delayMs + Math.min(timeoutMs, 1_000) > options.deadlineMs) {
          return { status: 'budget_exhausted', entries: [], invalidEntryCount: 0, truncated: false, attempts,
            error: 'reddit_request_budget_exhausted', failureClass: 'budget_exhausted', retryAfterMs: null };
        }
        await sleep(delayMs);
        continue;
      }
      return { status: 'failed', entries: [], invalidEntryCount: 0, truncated: false, attempts,
        error: error instanceof Error ? error.message : String(error), failureClass, retryAfterMs: null };
    }
    if (!response.ok) {
      const failureClass = classifyHttpFailure(response.status);
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const requestedDelayMs = retryable ? requestedRetryDelayMs(response.headers, now()) : null;
      lastRetryAfterMs = requestedDelayMs;
      if (retryable && attempt < maxAttempts) {
        const delayMs = requestedDelayMs ?? Math.min(1_000 * attempt, retryDelayCapMs);
        const retryIsBeyondCap = requestedDelayMs !== null && requestedDelayMs > retryDelayCapMs;
        const retryDoesNotFitBudget = options.deadlineMs !== undefined
          && now() + delayMs + Math.min(timeoutMs, 1_000) > options.deadlineMs;
        if (retryIsBeyondCap || retryDoesNotFitBudget) {
          return {
            status: response.status === 429 ? 'rate_limited' : retryDoesNotFitBudget ? 'budget_exhausted' : 'failed',
            entries: [], invalidEntryCount: 0, truncated: false, attempts,
            error: retryIsBeyondCap ? 'reddit_retry_deferred_by_cap' : 'reddit_request_budget_exhausted',
            failureClass: response.status === 429 ? 'rate_limit' : retryDoesNotFitBudget ? 'budget_exhausted' : failureClass,
            retryAfterMs: lastRetryAfterMs,
          };
        }
        await sleep(delayMs);
        continue;
      }
      return { status: response.status === 429 ? 'rate_limited' : 'failed', entries: [], invalidEntryCount: 0,
        truncated: false, attempts, error: `reddit_http_${response.status}`, failureClass, retryAfterMs: lastRetryAfterMs };
    }
    let xml: string;
    try {
      xml = await response.text();
    } catch (error) {
      return { status: 'failed', entries: [], invalidEntryCount: 0, truncated: false, attempts,
        error: error instanceof Error ? error.message : String(error), failureClass: 'body_read_error', retryAfterMs: null };
    }
    const parsed = parseRedditAtomFeed(xml, maxEntries, subreddit);
    if (parsed.error) {
      return { status: 'failed', entries: [], invalidEntryCount: 0, truncated: false, attempts,
        error: parsed.error, failureClass: 'parse_error', retryAfterMs: null };
    }
    if (parsed.invalidEntryCount > 0) {
      return { status: 'partial', entries: parsed.entries, invalidEntryCount: parsed.invalidEntryCount,
        truncated: parsed.truncated, attempts, error: 'malformed_atom_entries', failureClass: 'partial_feed', retryAfterMs: null };
    }
    return { status: parsed.entries.length === 0 ? 'empty' : 'ok', entries: parsed.entries,
      invalidEntryCount: 0, truncated: parsed.truncated, attempts, error: null, failureClass: null, retryAfterMs: null };
  }
  return { status: 'failed', entries: [], invalidEntryCount: 0, truncated: false, attempts,
    error: 'reddit_retry_exhausted', failureClass: 'retry_exhausted', retryAfterMs: lastRetryAfterMs };
}

export function assessRedditCoverage(input: {
  requestedStartUtc: string; requestedEndUtc: string; observedAtUtc: string;
  entries: RedditAtomEntry[]; feedStatus: RedditFeedFetchResult['status']; truncated: boolean;
}): RedditCoverageAssessment {
  if (input.feedStatus === 'empty') {
    return { coverageState: 'empty_unverified', gap: {
      observed_at_utc: input.observedAtUtc, requested_start_utc: input.requestedStartUtc,
      requested_end_utc: input.requestedEndUtc, reason: 'empty_feed_unverified', certainty: 'possible',
    } };
  }
  if (input.feedStatus === 'partial') {
    return { coverageState: 'partial', gap: {
      observed_at_utc: input.observedAtUtc, requested_start_utc: input.requestedStartUtc,
      requested_end_utc: input.requestedEndUtc, reason: 'partial_feed_response', certainty: 'unobserved',
    } };
  }
  if (input.truncated) {
    const oldest = [...input.entries].sort((a, b) => a.timestampUtc.localeCompare(b.timestampUtc))[0];
    return { coverageState: 'truncated', gap: {
      observed_at_utc: input.observedAtUtc, requested_start_utc: input.requestedStartUtc,
      requested_end_utc: input.requestedEndUtc, reason: 'feed_entry_limit', certainty: 'possible',
      ...(oldest ? { oldest_seen_at_utc: oldest.timestampUtc, oldest_seen_post_id: oldest.postId } : {}),
    } };
  }
  if (input.entries.length === 0) return { coverageState: 'covered', gap: null };
  const oldest = [...input.entries].sort((a, b) => a.timestampUtc.localeCompare(b.timestampUtc))[0];
  if (Date.parse(oldest.timestampUtc) > Date.parse(input.requestedStartUtc)) {
    return { coverageState: 'possible_gap', gap: {
      observed_at_utc: input.observedAtUtc, requested_start_utc: input.requestedStartUtc,
      requested_end_utc: input.requestedEndUtc, reason: 'rss_depth_did_not_reach_requested_start', certainty: 'possible',
      oldest_seen_at_utc: oldest.timestampUtc, oldest_seen_post_id: oldest.postId,
    } };
  }
  return { coverageState: 'covered', gap: null };
}
