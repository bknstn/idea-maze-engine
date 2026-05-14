/**
 * Reddit ingestion — fetches recent posts from configured subreddits.
 *
 * Reads subreddit list from app_state key "reddit_subreddits".
 * Falls back to RSS/Atom feed if JSON API returns 403/429.
 *
 * Usage: tsx ingest-reddit.ts
 *
 * Configure first:
 *   tsx -e "import {setAppState} from './lib/queries.ts'; setAppState('reddit_subreddits', ['SaaS','startups'])"
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { getDb, closeDb } from "./lib/db.ts";
import { DATA_DIR } from "./lib/paths.ts";
import { initSchema } from "./lib/schema.ts";
import { scoreSourceItem } from "./lib/scoring.ts";
import { upsertSourceItem, getAppState, setAppState } from "./lib/queries.ts";

const USER_AGENT = "idea-maze-engine/1.0";
const DEFAULT_HOURS = 24;
const DEFAULT_MAX_POSTS = 50;

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function rawPath(subreddit: string, postId: string, timestamp: Date): string {
  const safe = subreddit.replace(/\//g, "_");
  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, "0");
  const d = String(timestamp.getUTCDate()).padStart(2, "0");
  return resolve(DATA_DIR, "raw", "reddit", String(y), m, d, `${safe}_${postId}.json`);
}

// --- Atom/RSS fallback ---

function parseAtomText(xml: string): Array<{
  id: string;
  title: string;
  text: string;
  author: string | null;
  url: string | null;
  published: string;
}> {
  // Minimal XML parsing without external deps — extract <entry> blocks
  const entries: Array<{
    id: string;
    title: string;
    text: string;
    author: string | null;
    url: string | null;
    published: string;
  }> = [];

  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const tag = (name: string) => {
      const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
      return m ? m[1].trim() : "";
    };
    const linkMatch = block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/);
    const url = linkMatch ? linkMatch[1] : null;

    // Strip HTML from content
    const content = tag("content") || tag("summary");
    const text = content.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

    const authorMatch = block.match(/<author>\s*<name>([^<]+)<\/name>/);

    entries.push({
      id: tag("id"),
      title: tag("title").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
      text: text || tag("title"),
      author: authorMatch ? authorMatch[1] : null,
      url,
      published: tag("published") || tag("updated"),
    });
  }
  return entries;
}

function extractPostId(atomId: string, url: string | null): string {
  for (const value of [atomId, url ?? ""]) {
    const trimmed = value.replace(/\/+$/, "");
    if (trimmed.includes("comments/")) {
      const suffix = trimmed.split("comments/")[1];
      const candidate = suffix.split("/")[0];
      if (candidate) return candidate;
    }
    if (trimmed.startsWith("t3_")) return trimmed.slice(3);
  }
  return hashText(atomId).slice(0, 12);
}

// --- Main fetch logic ---

interface PostResult {
  source: "reddit";
  externalId: string;
  threadRef: string;
  author: string | null;
  title: string;
  text: string;
  canonicalUrl: string | null;
  channelOrLabel: string;
  timestampUtc: Date;
  rawPath: string;
  contentHash: string;
  sensitivity: string;
  metadata: Record<string, any>;
}

async function fetchSubredditJson(
  subreddit: string,
  cutoff: number,
  maxPosts: number,
): Promise<PostResult[]> {
  const items: PostResult[] = [];
  let after: string | null = null;

  while (items.length < maxPosts) {
    const limit = Math.min(100, maxPosts - items.length);
    const params = new URLSearchParams({
      limit: String(limit),
      raw_json: "1",
    });
    if (after) params.set("after", after);

    const url = `https://www.reddit.com/r/${subreddit}/new.json?${params}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });

    if (res.status === 403 || res.status === 429) {
      return fetchSubredditRss(subreddit, cutoff, maxPosts);
    }
    if (!res.ok) {
      console.error(`Reddit API error for r/${subreddit}: ${res.status}`);
      break;
    }

    const payload = (await res.json()) as any;
    const listing = payload?.data ?? {};
    const children: any[] = listing.children ?? [];
    if (!children.length) break;

    let reachedCutoff = false;
    for (const child of children) {
      const post = child.data ?? {};
      const created = Number(post.created_utc ?? 0);
      if (created < cutoff) {
        reachedCutoff = true;
        break;
      }

      if (post.over_18) continue; // skip NSFW

      const postId = String(post.id ?? "").trim();
      if (!postId) continue;

      const title = normalizeWhitespace(post.title ?? "");
      let text = normalizeWhitespace(post.selftext ?? "");
      if (!text) text = title;
      if (!text) continue;

      const timestamp = new Date(created * 1000);
      const permalink = post.permalink ? `https://www.reddit.com${post.permalink}` : null;
      const authorRaw = post.author;
      const fullname = String(post.name ?? `t3_${postId}`);

      const record = {
        subreddit: `r/${post.subreddit ?? subreddit}`,
        post_id: postId,
        fullname,
        created_at_utc: timestamp.toISOString(),
        author: authorRaw ? `u/${authorRaw}` : null,
        title: title || `Post in r/${subreddit}`,
        text,
        permalink,
        score: Number(post.score) || null,
        num_comments: Number(post.num_comments) || null,
        upvote_ratio: Number(post.upvote_ratio) || null,
        over_18: Boolean(post.over_18),
        domain: post.domain ?? null,
        link_flair_text: post.link_flair_text ?? null,
        url: post.url_overridden_by_dest ?? post.url ?? null,
      };

      const rp = rawPath(record.subreddit, postId, timestamp);
      writeJson(rp, record);

      items.push({
        source: "reddit",
        externalId: fullname,
        threadRef: fullname,
        author: record.author,
        title: record.title,
        text: record.text,
        canonicalUrl: permalink,
        channelOrLabel: record.subreddit,
        timestampUtc: timestamp,
        rawPath: rp,
        contentHash: hashText(`${record.title}\n${record.text}`),
        sensitivity: "normal",
        metadata: {
          subreddit: record.subreddit,
          post_id: postId,
          score: record.score,
          num_comments: record.num_comments,
          upvote_ratio: record.upvote_ratio,
          domain: record.domain,
          link_flair_text: record.link_flair_text,
          url: record.url,
          over_18: record.over_18,
        },
      });

      if (items.length >= maxPosts) break;
    }

    after = listing.after ?? null;
    if (reachedCutoff || !after) break;
  }

  return items;
}

async function fetchSubredditRss(
  subreddit: string,
  cutoff: number,
  maxPosts: number,
): Promise<PostResult[]> {
  const url = `https://www.reddit.com/r/${subreddit}/new/.rss`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    console.error(`Reddit RSS error for r/${subreddit}: ${res.status}`);
    return [];
  }

  const xml = await res.text();
  const entries = parseAtomText(xml);
  const items: PostResult[] = [];

  for (const entry of entries) {
    if (!entry.published) continue;
    const timestamp = new Date(entry.published.replace("Z", "+00:00"));
    if (timestamp.getTime() / 1000 < cutoff) continue;

    const postId = extractPostId(entry.id, entry.url);
    const fullname = `t3_${postId}`;
    const title = normalizeWhitespace(entry.title);
    const text = normalizeWhitespace(entry.text) || title;
    if (!text) continue;

    const record = {
      subreddit: `r/${subreddit}`,
      post_id: postId,
      fullname,
      created_at_utc: timestamp.toISOString(),
      author: entry.author ? `u/${entry.author}` : null,
      title: title || `Post in r/${subreddit}`,
      text,
      permalink: entry.url,
      score: null,
      num_comments: null,
      upvote_ratio: null,
      over_18: false,
      domain: null,
      link_flair_text: null,
      url: entry.url,
    };

    const rp = rawPath(record.subreddit, postId, timestamp);
    writeJson(rp, record);

    items.push({
      source: "reddit",
      externalId: fullname,
      threadRef: fullname,
      author: record.author,
      title: record.title,
      text: record.text,
      canonicalUrl: record.permalink,
      channelOrLabel: record.subreddit,
      timestampUtc: timestamp,
      rawPath: rp,
      contentHash: hashText(`${record.title}\n${record.text}`),
      sensitivity: "normal",
      metadata: {
        subreddit: record.subreddit,
        post_id: postId,
        score: null,
        num_comments: null,
        upvote_ratio: null,
        domain: null,
        link_flair_text: null,
        url: record.url,
        over_18: false,
        fetch_format: "atom",
      },
    });

    if (items.length >= maxPosts) break;
  }

  return items;
}

// --- Main ---

async function main() {
  const db = getDb();
  initSchema(db);

  const subreddits: string[] = getAppState("reddit_subreddits") ?? [];
  if (!subreddits.length) {
    console.error("No subreddits configured. Set app_state key 'reddit_subreddits' first.");
    console.error("  tsx -e \"import {setAppState} from './lib/queries.ts'; setAppState('reddit_subreddits', ['SaaS','startups'])\"");
    process.exit(1);
  }

  const hoursWindow = DEFAULT_HOURS;
  const maxPosts = DEFAULT_MAX_POSTS;
  const cutoff = Date.now() / 1000 - hoursWindow * 3600;

  let totalNew = 0;
  let totalUpdated = 0;

  for (const subreddit of subreddits) {
    console.log(`Fetching r/${subreddit}...`);
    const posts = await fetchSubredditJson(subreddit, cutoff, maxPosts);

    for (const post of posts) {
      // Compute harvest score
      const scoring = scoreSourceItem({
        source: post.source,
        author: post.author,
        title: post.title,
        text: post.text,
        canonical_url: post.canonicalUrl,
        metadata: post.metadata,
      });

      // Merge scoring into metadata
      const enrichedMeta = {
        ...post.metadata,
        harvest_score: scoring.score,
        harvest_signals: scoring.signals,
        source_patterns: scoring.patterns,
        harvest_breakdown: scoring.breakdown,
      };

      const { isNew } = upsertSourceItem({
        source: post.source,
        external_id: post.externalId,
        thread_ref: post.threadRef,
        author: post.author,
        title: post.title,
        text: post.text,
        canonical_url: post.canonicalUrl,
        channel_or_label: post.channelOrLabel,
        timestamp_utc: post.timestampUtc.toISOString(),
        raw_path: post.rawPath,
        content_hash: post.contentHash,
        sensitivity: post.sensitivity,
        metadata_json: enrichedMeta,
      });

      if (isNew) totalNew++;
      else totalUpdated++;
    }

    console.log(`  r/${subreddit}: ${posts.length} posts fetched`);
  }

  setAppState("reddit_last_harvest", new Date().toISOString());

  console.log(`\nDone. New: ${totalNew}, Updated: ${totalUpdated}`);
  closeDb();
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
