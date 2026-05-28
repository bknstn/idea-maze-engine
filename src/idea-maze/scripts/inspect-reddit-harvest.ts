import { getOption, hasFlag, writeJson } from './lib/cli.ts';
import { closeDb, getDb } from './lib/db.ts';
import { initSchema } from './lib/schema.ts';
import { classifyRedditTopicGroup, scoreSourceItem } from './lib/scoring.ts';

type SourceRow = {
  id: number;
  title: string | null;
  text: string;
  canonical_url: string | null;
  channel_or_label: string | null;
  author: string | null;
  timestamp_utc: string;
  ingested_at_utc: string;
  metadata_json: string;
  insight_count: number;
  insight_types: string | null;
};

type Summary = {
  total_items: number;
  daily_items: number;
  with_insights: number;
  without_insights: number;
};

function parseLimit(): number {
  const raw = Number(getOption('--limit') ?? 30);
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return Math.min(200, Math.trunc(raw));
}

function parseMetadata(raw: string): Record<string, any> {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function requireSince(): string {
  const since = getOption('--since');
  if (!since) {
    throw new Error('Missing required --since <ISO timestamp>');
  }
  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid --since timestamp: ${since}`);
  }
  return parsed.toISOString();
}

function main(): void {
  const since = requireSince();
  const limit = parseLimit();
  const json = hasFlag('--json');

  const db = getDb();
  initSchema(db);

  const rows = db.prepare(`
    SELECT
      si.id,
      si.title,
      si.text,
      si.canonical_url,
      si.channel_or_label,
      si.author,
      si.timestamp_utc,
      si.ingested_at_utc,
      si.metadata_json,
      COUNT(i.id) AS insight_count,
      GROUP_CONCAT(DISTINCT i.insight_type) AS insight_types
    FROM source_items si
    LEFT JOIN insights i ON i.source_item_id = si.id
    WHERE si.source = 'reddit'
      AND (si.timestamp_utc >= ? OR si.ingested_at_utc >= ?)
    GROUP BY si.id
    ORDER BY si.timestamp_utc DESC, si.id DESC
  `).all(since, since) as SourceRow[];

  const inspected = rows.map((row) => {
    const metadata = parseMetadata(row.metadata_json);
    const scoring = scoreSourceItem({
      source: 'reddit',
      author: row.author,
      title: row.title,
      text: row.text,
      canonical_url: row.canonical_url,
      metadata: {
        ...metadata,
        subreddit: metadata.subreddit ?? row.channel_or_label,
      },
    });
    const subreddit = String(metadata.subreddit ?? row.channel_or_label ?? '');
    return {
      id: row.id,
      subreddit,
      title: row.title ?? '',
      score: scoring.score,
      signals: scoring.signals,
      patterns: scoring.patterns,
      insight_count: Number(row.insight_count) || 0,
      insight_types: row.insight_types ? row.insight_types.split(',').filter(Boolean).sort() : [],
      topic_group: classifyRedditTopicGroup(subreddit),
      timestamp_utc: row.timestamp_utc,
      ingested_at_utc: row.ingested_at_utc,
    };
  });

  const dailyGroups = new Set(['health', 'learning', 'productivity', 'travel']);
  const summary: Summary = {
    total_items: inspected.length,
    daily_items: inspected.filter((item) => dailyGroups.has(item.topic_group)).length,
    with_insights: inspected.filter((item) => item.insight_count > 0).length,
    without_insights: inspected.filter((item) => item.insight_count === 0).length,
  };

  const signalCounts: Record<string, number> = {};
  const subredditCounts: Record<string, number> = {};
  for (const item of inspected) {
    subredditCounts[item.subreddit] = (subredditCounts[item.subreddit] ?? 0) + 1;
    for (const signal of item.signals) {
      signalCounts[signal] = (signalCounts[signal] ?? 0) + 1;
    }
  }

  const topSubreddits = Object.entries(subredditCounts)
    .map(([subreddit, count]) => ({ subreddit, count }))
    .sort((a, b) => b.count - a.count || a.subreddit.localeCompare(b.subreddit));

  const topItems = inspected
    .sort((a, b) => b.score - a.score || b.insight_count - a.insight_count || b.timestamp_utc.localeCompare(a.timestamp_utc))
    .slice(0, limit)
    .map(({ timestamp_utc: _timestamp, ingested_at_utc: _ingested, ...item }) => item);

  const output = {
    since,
    summary,
    signal_counts: Object.fromEntries(Object.entries(signalCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    top_subreddits: topSubreddits,
    top_items: topItems,
  };

  if (json) {
    writeJson(output);
  } else {
    console.log(`Reddit harvest since ${since}`);
    console.log(`Items: ${summary.total_items} (${summary.daily_items} daily-routine), insights: ${summary.with_insights}/${summary.total_items}`);
    console.log('Top items:');
    for (const item of topItems) {
      console.log(`- ${item.score.toFixed(3)} ${item.subreddit} [${item.topic_group}] ${item.title}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  closeDb();
}
