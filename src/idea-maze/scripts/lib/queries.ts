import type Database from 'better-sqlite3';
import { getDb } from './db.ts';

// --- App State ---

export function getAppState(key: string): any | null {
  const db = getDb();
  const row = db
    .prepare('SELECT value_json FROM app_state WHERE key = ?')
    .get(key) as { value_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.value_json);
}

export function setAppState(key: string, value: any): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO app_state (key, value_json, updated_at_utc)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_utc = excluded.updated_at_utc`,
  ).run(key, JSON.stringify(value), now);
}

// --- Source Items ---

export interface SourceItemRow {
  id: number;
  source: string;
  external_id: string;
  thread_ref: string | null;
  author: string | null;
  title: string | null;
  text: string;
  canonical_url: string | null;
  channel_or_label: string | null;
  timestamp_utc: string;
  ingested_at_utc: string;
  raw_path: string;
  content_hash: string;
  sensitivity: string;
  metadata_json: string;
}

export interface UpsertSourceItem {
  source: string;
  external_id: string;
  thread_ref?: string | null;
  author?: string | null;
  title?: string | null;
  text: string;
  canonical_url?: string | null;
  channel_or_label?: string | null;
  timestamp_utc: string;
  raw_path: string;
  content_hash: string;
  sensitivity?: string;
  metadata_json: Record<string, any>;
}

/**
 * Insert or update a source item. Returns { id, isNew }.
 * Deduplicates on (source, external_id). On conflict, updates metadata
 * and text but preserves the original ingested_at_utc.
 */
export function upsertSourceItem(item: UpsertSourceItem): {
  id: number;
  isNew: boolean;
} {
  const db = getDb();
  const now = new Date().toISOString();
  const metaStr = JSON.stringify(item.metadata_json);

  // Try insert first
  const insert = db.prepare(`
    INSERT OR IGNORE INTO source_items
      (source, external_id, thread_ref, author, title, text,
       canonical_url, channel_or_label, timestamp_utc, ingested_at_utc,
       raw_path, content_hash, sensitivity, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = insert.run(
    item.source,
    item.external_id,
    item.thread_ref ?? null,
    item.author ?? null,
    item.title ?? null,
    item.text,
    item.canonical_url ?? null,
    item.channel_or_label ?? null,
    item.timestamp_utc,
    now,
    item.raw_path,
    item.content_hash,
    item.sensitivity ?? 'normal',
    metaStr,
  );

  if (result.changes > 0) {
    return { id: Number(result.lastInsertRowid), isNew: true };
  }

  // Row exists — update mutable fields
  db.prepare(
    `
    UPDATE source_items
    SET text = ?, title = ?, metadata_json = ?, content_hash = ?, raw_path = ?
    WHERE source = ? AND external_id = ?
  `,
  ).run(
    item.text,
    item.title ?? null,
    metaStr,
    item.content_hash,
    item.raw_path,
    item.source,
    item.external_id,
  );

  const existing = db
    .prepare('SELECT id FROM source_items WHERE source = ? AND external_id = ?')
    .get(item.source, item.external_id) as { id: number };

  return { id: existing.id, isNew: false };
}

/**
 * Get source items that have no insights extracted yet.
 */
export function getUnprocessedItems(limit = 100): SourceItemRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT si.* FROM source_items si
       LEFT JOIN insights i ON i.source_item_id = si.id
       WHERE i.id IS NULL
       ORDER BY json_extract(si.metadata_json, '$.harvest_score') DESC, si.timestamp_utc DESC
       LIMIT ?`,
    )
    .all(limit) as SourceItemRow[];
}

/**
 * Get source items filtered by source type.
 */
export function getItemsBySource(source: string, limit = 100): SourceItemRow[] {
  const db = getDb();
  return db
    .prepare(
      'SELECT * FROM source_items WHERE source = ? ORDER BY timestamp_utc DESC LIMIT ?',
    )
    .all(source, limit) as SourceItemRow[];
}

/**
 * Full-text search across source items.
 */
export function searchSourceItems(query: string, limit = 50): SourceItemRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT si.* FROM source_items si
       JOIN source_items_fts fts ON fts.rowid = si.id
       WHERE source_items_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit) as SourceItemRow[];
}

// --- Run Lock ---

/**
 * Acquire a run lock for a pipeline stage. Returns true if acquired.
 * Prevents overlapping runs of the same type. Lock expires after maxAgeMs.
 */
export function acquireRunLock(
  stage: string,
  maxAgeMs = 30 * 60 * 1000,
): boolean {
  const db = getDb();
  const now = new Date();
  const lockKey = `lock:${stage}`;
  const existing = getAppState(lockKey);
  if (existing) {
    const lockedAt = new Date(existing.locked_at);
    if (now.getTime() - lockedAt.getTime() < maxAgeMs) {
      return false; // Lock still held
    }
  }
  setAppState(lockKey, { locked_at: now.toISOString(), pid: process.pid });
  return true;
}

/**
 * Release a run lock.
 */
export function releaseRunLock(stage: string): void {
  const db = getDb();
  db.prepare('DELETE FROM app_state WHERE key = ?').run(`lock:${stage}`);
}

// --- Counts ---

export function getCounts(): {
  source_items: number;
  insights: number;
  opportunities: number;
  runs_pending: number;
  artifacts: number;
} {
  const db = getDb();
  return {
    source_items: (
      db.prepare('SELECT COUNT(*) as n FROM source_items').get() as any
    ).n,
    insights: (db.prepare('SELECT COUNT(*) as n FROM insights').get() as any).n,
    opportunities: (
      db.prepare('SELECT COUNT(*) as n FROM opportunities').get() as any
    ).n,
    runs_pending: (
      db
        .prepare(
          "SELECT COUNT(*) as n FROM runs WHERE status IN ('draft_ready', 'review_gate', 'running')",
        )
        .get() as any
    ).n,
    artifacts: (db.prepare('SELECT COUNT(*) as n FROM artifacts').get() as any)
      .n,
  };
}
