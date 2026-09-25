/** Per-subreddit Reddit RSS ingestion with persisted range and gap tracking. */

import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type Database from 'better-sqlite3';

import { closeDb, getDb } from './lib/db.ts';
import { DATA_DIR } from './lib/paths.ts';
import { initSchema } from './lib/schema.ts';
import { scoreSourceItem } from './lib/scoring.ts';
import { getAppState, setAppState, setAppStates, upsertSourceItem } from './lib/queries.ts';
import {
  assessRedditCoverage,
  fetchRedditAtomFeed,
  nextRedditHarvestCursor,
  normalizeRedditSubreddits,
  selectRedditHarvestBatch,
  type RedditAtomEntry,
  type RedditCoverageGap,
  type RedditFeedFetchResult,
} from './lib/reddit-harvest.ts';

const DEFAULT_HOURS = 24;
const DEFAULT_OVERLAP_MINUTES = 60;
const DEFAULT_POSTS_PER_SUBREDDIT = 50;
const DEFAULT_SUBREDDITS_PER_RUN = 6;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_BUDGET_MS = 120_000;
const DEFAULT_RETRY_DELAY_CAP_MS = 30_000;
const MAX_RETAINED_GAPS = 50;

interface PersistedSubredditState {
  last_attempt_at_utc: string | null;
  last_success_at_utc: string | null;
  cursor_timestamp_utc: string | null;
  cursor_post_id: string | null;
  requested_start_utc: string | null;
  requested_end_utc: string | null;
  observed_oldest_at_utc: string | null;
  observed_oldest_post_id: string | null;
  observed_newest_at_utc: string | null;
  observed_newest_post_id: string | null;
  coverage_state: string;
  last_range_coverage_state: string;
  coverage_gaps: RedditCoverageGap[];
  last_failure: { at_utc: string; failure_class: string; error: string } | null;
  last_run: { fetched_count: number; new_count: number; updated_count: number; changed_count: number; unchanged_count: number; status: string } | null;
}

type PersistedRedditState = Record<string, PersistedSubredditState>;

interface HarvestSubredditResult {
  subreddit: string;
  status: string;
  failure_class: string | null;
  error: string | null;
  fetched_count: number;
  received_count: number;
  new_count: number;
  updated_count: number;
  changed_count: number;
  unchanged_count: number;
  attempts: number;
  requested_start_utc: string;
  requested_end_utc: string;
  coverage_state: string;
  last_range_coverage_state: string;
  coverage_gap: RedditCoverageGap | null;
}

interface RedditHarvestRunSummary {
  harvested_at_utc: string;
  configured_count: number;
  shard_index: number;
  shard_count: number;
  selected_subreddits: string[];
  next_cursor: number;
  fetched_count: number;
  fetched_by_subreddit: Record<string, number>;
  new_count: number;
  updated_count: number;
  changed_count: number;
  unchanged_count: number;
  successful_check_count: number;
  attempted_count: number;
  request_count: number;
  request_budget_ms: number;
  duration_ms: number;
  invalid_subreddits: string[];
  deferred_subreddits: Array<{ subreddit: string; reason: string }>;
  subreddits: HarvestSubredditResult[];
  coverage_gaps: RedditCoverageGap[];
  failures: Array<{ subreddit: string; failure_class: string; error: string | null }>;
  schedule_recommendation: {
    candidate_interval_hours: number;
    estimated_rotation_hours: number;
    status: 'provisional_unverified';
    reason: string;
  };
}

export interface IngestRedditOptions {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => Date;
  maxSubredditsPerRun?: number;
  maxPostsPerSubreddit?: number;
  requestTimeoutMs?: number;
  requestBudgetMs?: number;
  retryDelayCapMs?: number;
  dataDir?: string;
  log?: (message: string) => void;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function asObject(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function defaultSubredditState(): PersistedSubredditState {
  return {
    last_attempt_at_utc: null,
    last_success_at_utc: null,
    cursor_timestamp_utc: null,
    cursor_post_id: null,
    requested_start_utc: null,
    requested_end_utc: null,
    observed_oldest_at_utc: null,
    observed_oldest_post_id: null,
    observed_newest_at_utc: null,
    observed_newest_post_id: null,
    coverage_state: 'never_checked',
    last_range_coverage_state: 'never_checked',
    coverage_gaps: [],
    last_failure: null,
    last_run: null,
  };
}

function loadPersistedState(): PersistedRedditState {
  const raw = asObject(getAppState('reddit_harvest_state'));
  const state: PersistedRedditState = {};
  for (const [subreddit, value] of Object.entries(raw)) {
    state[subreddit] = { ...defaultSubredditState(), ...asObject(value) } as PersistedSubredditState;
  }
  return state;
}

function appendGap(gaps: RedditCoverageGap[], gap: RedditCoverageGap | null): RedditCoverageGap[] {
  if (!gap) return gaps.slice(-MAX_RETAINED_GAPS);
  const key = `${gap.requested_start_utc}|${gap.requested_end_utc}|${gap.reason}|${gap.oldest_seen_post_id ?? ''}`;
  const withoutDuplicate = gaps.filter((item) =>
    `${item.requested_start_utc}|${item.requested_end_utc}|${item.reason}|${item.oldest_seen_post_id ?? ''}` !== key,
  );
  return [...withoutDuplicate, gap].slice(-MAX_RETAINED_GAPS);
}

function rawPath(dataDir: string, subreddit: string, postId: string, timestamp: Date): string {
  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const d = String(timestamp.getUTCDate()).padStart(2, '0');
  return resolve(dataDir, 'raw', 'reddit', String(y), m, d, `${subreddit}_${postId}.json`);
}

function writeJsonAtomically(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', flag: 'wx' });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function buildPost(entry: RedditAtomEntry, dataDir: string) {
  const timestamp = new Date(entry.timestampUtc);
  const channelOrLabel = `r/${entry.subreddit}`;
  const author = !entry.author || entry.author.toLowerCase() === '[deleted]'
    ? null
    : entry.author.startsWith('u/') ? entry.author : `u/${entry.author}`;
  const rawRecord = {
    subreddit: channelOrLabel,
    post_id: entry.postId,
    fullname: `t3_${entry.postId}`,
    created_at_utc: timestamp.toISOString(),
    author,
    title: entry.title,
    text: entry.text,
    permalink: entry.url,
    score: null,
    num_comments: null,
    upvote_ratio: null,
    over_18: null,
    domain: null,
    link_flair_text: null,
    url: entry.url,
    fetch_format: 'atom',
  };
  return {
    rawRecord,
    sourceItem: {
      source: 'reddit',
      external_id: `t3_${entry.postId}`,
      thread_ref: `t3_${entry.postId}`,
      author,
      title: entry.title,
      text: entry.text,
      canonical_url: entry.url,
      channel_or_label: channelOrLabel,
      timestamp_utc: timestamp.toISOString(),
      raw_path: rawPath(dataDir, entry.subreddit, entry.postId, timestamp),
      content_hash: hashText(`${entry.title}\n${entry.text}`),
      sensitivity: 'normal',
      metadata_json: {
        subreddit: channelOrLabel,
        post_id: entry.postId,
        score: null,
        num_comments: null,
        upvote_ratio: null,
        domain: null,
        link_flair_text: null,
        url: entry.url,
        over_18: null,
        fetch_format: 'atom',
        author_available: author !== null,
      },
    },
  };
}

function selectWindowEntries(entries: RedditAtomEntry[], startUtc: string, endUtc: string): RedditAtomEntry[] {
  const startMs = Date.parse(startUtc);
  const endMs = Date.parse(endUtc);
  return entries.filter((entry) => {
    const timestamp = Date.parse(entry.timestampUtc);
    return timestamp >= startMs && timestamp <= endMs;
  });
}

function newestAndOldest(entries: RedditAtomEntry[]): {
  newest: RedditAtomEntry | null;
  oldest: RedditAtomEntry | null;
} {
  if (!entries.length) return { newest: null, oldest: null };
  const sorted = [...entries].sort((a, b) =>
    a.timestampUtc.localeCompare(b.timestampUtc) || a.postId.localeCompare(b.postId),
  );
  return { oldest: sorted[0], newest: sorted[sorted.length - 1] };
}

function cursorEntryAfter(
  entry: RedditAtomEntry,
  currentTimestampUtc: string | null,
  currentPostId: string | null,
): boolean {
  if (!currentTimestampUtc || !currentPostId) return true;
  const timestampOrder = Date.parse(entry.timestampUtc) - Date.parse(currentTimestampUtc);
  if (timestampOrder !== 0) return timestampOrder > 0;
  return entry.postId.toLowerCase() > currentPostId.toLowerCase();
}

function makeGap(
  start: string,
  end: string,
  observed: string,
  reason: string,
  certainty: 'possible' | 'unobserved',
): RedditCoverageGap {
  return {
    observed_at_utc: observed,
    requested_start_utc: start,
    requested_end_utc: end,
    reason,
    certainty,
  };
}

function buildScheduleRecommendation(configuredCount: number, batchSize: number) {
  const rotationRuns = Math.max(1, Math.ceil(configuredCount / batchSize));
  const candidateIntervalHours = 4;
  return {
    candidate_interval_hours: candidateIntervalHours,
    estimated_rotation_hours: rotationRuns * candidateIntervalHours,
    status: 'provisional_unverified' as const,
    reason: `At ${batchSize} feeds per run, ${configuredCount} configured subreddits need about ${rotationRuns} runs per rotation. Four hours is a provisional cadence only; validate oldest-entry depth and 429 frequency from manual runs before enabling a schedule.`,
  };
}

function summarizeLegacyFields(summary: RedditHarvestRunSummary) {
  return {
    harvested_at_utc: summary.harvested_at_utc,
    configured_count: summary.configured_count,
    shard_index: summary.shard_index,
    shard_count: summary.shard_count,
    selected_subreddits: summary.selected_subreddits,
    next_cursor: summary.next_cursor,
    fetched_count: summary.fetched_count,
    fetched_by_subreddit: summary.fetched_by_subreddit,
    new_count: summary.new_count,
    updated_count: summary.updated_count,
    changed_count: summary.changed_count,
    unchanged_count: summary.unchanged_count,
    successful_check_count: summary.successful_check_count,
    attempted_count: summary.attempted_count,
    request_count: summary.request_count,
    request_budget_ms: summary.request_budget_ms,
    duration_ms: summary.duration_ms,
    invalid_subreddits: summary.invalid_subreddits,
    deferred_subreddits: summary.deferred_subreddits,
    subreddits: summary.subreddits,
    coverage_gaps: summary.coverage_gaps,
    failures: summary.failures,
    schedule_recommendation: summary.schedule_recommendation,
  };
}

function persistSubredditResult(
  db: Database.Database,
  subreddit: string,
  entries: RedditAtomEntry[],
  result: RedditFeedFetchResult,
  requestedStartUtc: string,
  requestedEndUtc: string,
  observedAtUtc: string,
  previousState: PersistedSubredditState,
  state: PersistedRedditState,
  dataDir: string,
  advanceSuccess: boolean,
  schedulerCursor: number,
): { state: PersistedSubredditState; newCount: number; updatedCount: number; changedCount: number; unchangedCount: number; persistedCount: number; gap: RedditCoverageGap | null } {
  const inRange = selectWindowEntries(entries, requestedStartUtc, requestedEndUtc);
  const { newest, oldest } = newestAndOldest(entries);
  const inRangeBounds = newestAndOldest(inRange);
  const cursorCandidate = inRangeBounds.newest;
  const cursorAdvances = advanceSuccess && cursorCandidate
    && cursorEntryAfter(cursorCandidate, previousState.cursor_timestamp_utc, previousState.cursor_post_id);
  const assessment = assessRedditCoverage({
    requestedStartUtc,
    requestedEndUtc,
    observedAtUtc,
    entries,
    feedStatus: result.status,
    truncated: result.truncated,
  });
  let newCount = 0;
  let updatedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  const posts = inRange.map((entry) => buildPost(entry, dataDir));

  // Raw files use atomic renames; a failure prevents both the row writes and cursor update.
  for (const post of posts) writeJsonAtomically(post.sourceItem.raw_path, post.rawRecord);

  const nextState: PersistedSubredditState = {
    ...previousState,
    last_attempt_at_utc: observedAtUtc,
    last_success_at_utc: advanceSuccess ? observedAtUtc : previousState.last_success_at_utc,
    cursor_timestamp_utc: cursorAdvances ? cursorCandidate.timestampUtc : previousState.cursor_timestamp_utc,
    cursor_post_id: cursorAdvances ? cursorCandidate.postId : previousState.cursor_post_id,
    requested_start_utc: requestedStartUtc,
    requested_end_utc: requestedEndUtc,
    observed_oldest_at_utc: oldest?.timestampUtc ?? null,
    observed_oldest_post_id: oldest?.postId ?? null,
    observed_newest_at_utc: newest?.timestampUtc ?? null,
    observed_newest_post_id: newest?.postId ?? null,
    coverage_state: previousState.coverage_gaps.length > 0 && assessment.coverageState === 'covered'
      ? 'possible_gap'
      : assessment.coverageState,
    last_range_coverage_state: assessment.coverageState,
    coverage_gaps: appendGap(previousState.coverage_gaps, assessment.gap),
    last_failure: result.status === 'partial'
      ? { at_utc: observedAtUtc, failure_class: result.failureClass ?? 'partial_feed', error: result.error ?? 'partial_feed' }
      : result.status === 'ok' || result.status === 'empty' ? null : previousState.last_failure,
    last_run: {
      fetched_count: inRange.length,
      new_count: 0,
      updated_count: 0,
      changed_count: 0,
      unchanged_count: 0,
      status: result.status,
    },
  };

  db.transaction(() => {
    for (const post of posts) {
      const scoring = scoreSourceItem({
        source: 'reddit',
        author: post.sourceItem.author,
        title: post.sourceItem.title,
        text: post.sourceItem.text,
        canonical_url: post.sourceItem.canonical_url,
        metadata: post.sourceItem.metadata_json,
      });
      const enrichedMetadata = {
        ...post.sourceItem.metadata_json,
        harvest_score: scoring.score,
        harvest_signals: scoring.signals,
        source_patterns: scoring.patterns,
        harvest_breakdown: scoring.breakdown,
      };
      const existing = db.prepare(`
        SELECT title, text, metadata_json, content_hash, raw_path, canonical_url, channel_or_label
        FROM source_items WHERE source = ? AND external_id = ?
      `).get(post.sourceItem.source, post.sourceItem.external_id) as {
        title: string | null;
        text: string;
        metadata_json: string;
        content_hash: string;
        raw_path: string;
        canonical_url: string | null;
        channel_or_label: string | null;
      } | undefined;
      const { isNew } = upsertSourceItem({
        ...post.sourceItem,
        metadata_json: enrichedMetadata,
      });
      if (isNew) newCount += 1;
      else {
        // Keep updated_count compatible: it means the upsert matched an existing row.
        updatedCount += 1;
        let existingMetadata: unknown = {};
        try { existingMetadata = JSON.parse(existing?.metadata_json ?? '{}'); } catch { /* treat invalid stored JSON as changed */ }
        const changed = !existing
          || existing.content_hash !== post.sourceItem.content_hash
          || existing.title !== post.sourceItem.title
          || existing.text !== post.sourceItem.text
          || existing.raw_path !== post.sourceItem.raw_path
          || existing.canonical_url !== post.sourceItem.canonical_url
          || existing.channel_or_label !== post.sourceItem.channel_or_label
          || stableJson(existingMetadata) !== stableJson(enrichedMetadata);
        if (changed) changedCount += 1;
        else unchangedCount += 1;
      }
    }
    nextState.last_run = { fetched_count: inRange.length, new_count: newCount, updated_count: updatedCount, changed_count: changedCount, unchanged_count: unchangedCount, status: result.status };
    state[subreddit] = nextState;
    setAppState('reddit_harvest_state', state);
    setAppState('reddit_harvest_cursor', schedulerCursor);
    if (advanceSuccess) setAppState('reddit_last_harvest', observedAtUtc);
  })();

  return { state: nextState, newCount, updatedCount, changedCount, unchangedCount, persistedCount: posts.length, gap: assessment.gap };
}

function persistFailure(
  db: Database.Database,
  subreddit: string,
  previousState: PersistedSubredditState,
  state: PersistedRedditState,
  requestedStartUtc: string,
  requestedEndUtc: string,
  observedAtUtc: string,
  failureClass: string,
  error: string,
  schedulerCursor: number,
): PersistedSubredditState {
  const gap = makeGap(requestedStartUtc, requestedEndUtc, observedAtUtc, failureClass, 'unobserved');
  const nextState: PersistedSubredditState = {
    ...previousState,
    last_attempt_at_utc: observedAtUtc,
    requested_start_utc: requestedStartUtc,
    requested_end_utc: requestedEndUtc,
    coverage_state: failureClass,
    last_range_coverage_state: 'unobserved',
    coverage_gaps: appendGap(previousState.coverage_gaps, gap),
    last_failure: { at_utc: observedAtUtc, failure_class: failureClass, error },
    last_run: { fetched_count: 0, new_count: 0, updated_count: 0, changed_count: 0, unchanged_count: 0, status: failureClass },
  };
  db.transaction(() => {
    state[subreddit] = nextState;
    setAppState('reddit_harvest_state', state);
    setAppState('reddit_harvest_cursor', schedulerCursor);
  })();
  return nextState;
}

export async function main(options: IngestRedditOptions = {}): Promise<RedditHarvestRunSummary> {
  const db = getDb();
  initSchema(db);
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.log(message));
  const batchSize = options.maxSubredditsPerRun ?? DEFAULT_SUBREDDITS_PER_RUN;
  const maxPosts = options.maxPostsPerSubreddit ?? DEFAULT_POSTS_PER_SUBREDDIT;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const budgetMs = options.requestBudgetMs ?? DEFAULT_REQUEST_BUDGET_MS;
  const dataDir = options.dataDir ?? DATA_DIR;
  const runStartedMs = now().getTime();
  const startedAtUtc = new Date(runStartedMs).toISOString();
  const configured = normalizeRedditSubreddits(getAppState('reddit_subreddits'));
  if (configured.valid.length === 0) {
    closeDb();
    throw new Error('No valid subreddits configured. Set app_state key reddit_subreddits first.');
  }

  const legacyCursor = Number(getAppState('reddit_harvest_cursor') ?? 0);
  const batch = selectRedditHarvestBatch(configured.valid, legacyCursor, batchSize);
  const state = loadPersistedState();
  const results: HarvestSubredditResult[] = [];
  const fetchedBySubreddit: Record<string, number> = {};
  const deferred: Array<{ subreddit: string; reason: string }> = batch.deferred.map((subreddit) => ({ subreddit, reason: 'rotation_batch_limit' }));
  let totalNew = 0;
  let totalUpdated = 0;
  let totalChanged = 0;
  let totalUnchanged = 0;
  let totalFetched = 0;
  let requestCount = 0;
  let attemptedCount = 0;
  let nextCursor = batch.cursor;
  let stopReason: string | null = null;

  log(`Checking Reddit feeds ${batch.cursor + 1}..${Math.min(batch.cursor + batch.selected.length, batch.configured.length)} of ${batch.configured.length}: ${batch.selected.map((name) => `r/${name}`).join(', ')}`);

  for (let index = 0; index < batch.selected.length; index += 1) {
    const subreddit = batch.selected[index];
    const currentMs = now().getTime();
    if (currentMs - runStartedMs >= budgetMs) {
      stopReason = 'request_budget_exhausted';
      deferred.push(...batch.selected.slice(index).map((pending) => ({ subreddit: pending, reason: stopReason! })));
      break;
    }
    const observedAtUtc = now().toISOString();
    const previousState = state[subreddit] ?? defaultSubredditState();
    const requestedEndUtc = observedAtUtc;
    const defaultStartMs = currentMs - DEFAULT_HOURS * 60 * 60 * 1000;
    const priorSuccessMs = previousState.last_success_at_utc ? Date.parse(previousState.last_success_at_utc) : Number.NaN;
    const requestedStartUtc = new Date(Number.isFinite(priorSuccessMs)
      ? priorSuccessMs - DEFAULT_OVERLAP_MINUTES * 60 * 1000
      : defaultStartMs).toISOString();
    const deadlineMs = runStartedMs + budgetMs;
    const result = await fetchRedditAtomFeed(subreddit, {
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      now: () => now().getTime(),
      timeoutMs,
      maxAttempts: 2,
      retryDelayCapMs: options.retryDelayCapMs ?? DEFAULT_RETRY_DELAY_CAP_MS,
      deadlineMs,
      maxEntries: maxPosts,
    });
    requestCount += result.attempts;
    attemptedCount += result.attempts > 0 ? 1 : 0;
    nextCursor = nextRedditHarvestCursor(batch.configured.length, batch.cursor, attemptedCount);
    const coverageGap = result.status === 'ok' || result.status === 'empty' || result.status === 'partial'
      ? assessRedditCoverage({ requestedStartUtc, requestedEndUtc, observedAtUtc, entries: result.entries, feedStatus: result.status, truncated: result.truncated }).gap
      : null;
    let rowCoverageGap = coverageGap;
    let persistedCount = 0;
    let newCount = 0;
    let updatedCount = 0;
    let finalStatus: string = result.status;
    let failureClass = result.failureClass;
    let error = result.error;
    let coverageState: string = result.status;

    if (result.status === 'ok' || result.status === 'empty' || result.status === 'partial') {
      try {
        const advanceSuccess = result.status === 'ok' && !result.truncated;
        const persisted = persistSubredditResult(
          db, subreddit, result.entries, result, requestedStartUtc, requestedEndUtc,
          observedAtUtc, previousState, state, dataDir, advanceSuccess, nextCursor,
        );
        persistedCount = persisted.persistedCount;
        newCount = persisted.newCount;
        updatedCount = persisted.updatedCount;
        totalChanged += persisted.changedCount;
        totalUnchanged += persisted.unchangedCount;
        coverageState = persisted.state.coverage_state;
        finalStatus = result.status === 'partial' ? 'partial' : coverageState;
        failureClass = result.status === 'partial' ? result.failureClass : null;
        error = result.status === 'partial' ? result.error : null;
      } catch (persistenceError) {
        failureClass = 'persistence_error';
        error = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
        finalStatus = 'persistence_error';
        coverageState = 'persistence_error';
        const failureState = { ...state, [subreddit]: previousState };
        persistFailure(db, subreddit, previousState, failureState, requestedStartUtc, requestedEndUtc,
          observedAtUtc, failureClass, error, nextCursor);
        state[subreddit] = failureState[subreddit];
        rowCoverageGap = state[subreddit]?.coverage_gaps.at(-1) ?? makeGap(
          requestedStartUtc, requestedEndUtc, observedAtUtc, failureClass, 'unobserved',
        );
      }
    } else {
      failureClass ??= result.status === 'budget_exhausted' ? 'budget_exhausted' : 'request_failed';
      error ??= result.status;
      const failureState = { ...state, [subreddit]: previousState };
      const next = persistFailure(db, subreddit, previousState, failureState, requestedStartUtc, requestedEndUtc,
        observedAtUtc, failureClass, error, nextCursor);
      state[subreddit] = next;
      rowCoverageGap = next.coverage_gaps.at(-1) ?? makeGap(
        requestedStartUtc, requestedEndUtc, observedAtUtc, failureClass, 'unobserved',
      );
      coverageState = failureClass;
      finalStatus = result.status;
    }

    totalFetched += persistedCount;
    totalNew += newCount;
    totalUpdated += updatedCount;
    fetchedBySubreddit[`r/${subreddit}`] = persistedCount;
    const row: HarvestSubredditResult = {
      subreddit,
      status: finalStatus,
      failure_class: failureClass,
      error,
      fetched_count: persistedCount,
      received_count: result.entries.length,
      new_count: newCount,
      updated_count: updatedCount,
      changed_count: result.status === 'ok' || result.status === 'empty' || result.status === 'partial'
        ? state[subreddit]?.last_run?.changed_count ?? 0
        : 0,
      unchanged_count: result.status === 'ok' || result.status === 'empty' || result.status === 'partial'
        ? state[subreddit]?.last_run?.unchanged_count ?? 0
        : 0,
      attempts: result.attempts,
      requested_start_utc: requestedStartUtc,
      requested_end_utc: requestedEndUtc,
      coverage_state: coverageState,
      last_range_coverage_state: state[subreddit]?.last_range_coverage_state ?? coverageState,
      coverage_gap: rowCoverageGap,
    };
    results.push(row);

    if (result.status === 'rate_limited') {
      stopReason = 'global_rate_limit';
      deferred.push(...batch.selected.slice(index + 1).map((pending) => ({ subreddit: pending, reason: stopReason! })));
      break;
    }
    if (result.status === 'budget_exhausted') {
      stopReason = 'request_budget_exhausted';
      deferred.push(...batch.selected.slice(index + 1).map((pending) => ({ subreddit: pending, reason: stopReason! })));
      break;
    }
  }

  const completedAtUtc = now().toISOString();
  const allGaps = Object.entries(state).flatMap(([subreddit, subredditState]) =>
    subredditState.coverage_gaps.map((gap) => ({ ...gap, subreddit } as RedditCoverageGap & { subreddit: string })),
  );
  const failures = results
    .filter((item) => item.failure_class)
    .map((item) => ({ subreddit: item.subreddit, failure_class: item.failure_class!, error: item.error }));
  const summary: RedditHarvestRunSummary = {
    harvested_at_utc: startedAtUtc,
    configured_count: batch.configured.length,
    shard_index: batch.cursor,
    shard_count: batch.shardCount,
    selected_subreddits: batch.selected,
    next_cursor: nextCursor,
    fetched_count: totalFetched,
    fetched_by_subreddit: fetchedBySubreddit,
    new_count: totalNew,
    updated_count: totalUpdated,
    changed_count: totalChanged,
    unchanged_count: totalUnchanged,
    successful_check_count: results.filter((item) =>
      item.failure_class === null && ['covered', 'possible_gap'].includes(item.last_range_coverage_state),
    ).length,
    attempted_count: attemptedCount,
    request_count: requestCount,
    request_budget_ms: budgetMs,
    duration_ms: Math.max(0, now().getTime() - runStartedMs),
    invalid_subreddits: configured.invalid,
    deferred_subreddits: deferred,
    subreddits: results,
    coverage_gaps: allGaps,
    failures,
    schedule_recommendation: buildScheduleRecommendation(batch.configured.length, batchSize),
  };

  // Keep the historical key and its existing fields for older status consumers.
  setAppStates({
    reddit_harvest_cursor: nextCursor,
    reddit_last_harvest_summary: summarizeLegacyFields(summary),
    reddit_harvest_status: { ...summary, completed_at_utc: completedAtUtc, stop_reason: stopReason },
  });
  log(`Done. Fetched ${totalFetched}, new ${totalNew}, updated ${totalUpdated}; checked ${results.length}/${batch.selected.length}; deferred ${deferred.length}.`);
  closeDb();
  return summary;
}

export function redditHarvestExitCode(summary: RedditHarvestRunSummary): number {
  return summary.invalid_subreddits.length === 0
    && summary.successful_check_count > 0
    && summary.failures.length === 0
    && summary.successful_check_count === summary.subreddits.length
    ? 0
    : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((summary) => {
    if (redditHarvestExitCode(summary) !== 0) {
      console.error('Reddit harvest was incomplete; inspect idea:status -- --json for per-subreddit failures and gaps.');
      process.exitCode = 1;
    }
  }).catch((error) => {
    closeDb();
    console.error('Reddit ingestion failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
