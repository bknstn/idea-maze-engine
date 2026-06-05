import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { findRejectedDuplicate } from './duplicate-opportunities.ts';
import { initSchema } from './schema.ts';

function insertOpportunity(
  db: Database.Database,
  input: { slug: string; title: string; thesis: string; cluster_key: string; lifecycle_stage?: string },
): number {
  const now = '2026-06-01T00:00:00.000Z';
  const result = db
    .prepare(
      `
      INSERT INTO opportunities (
        slug, title, thesis, score, market_score, taste_adjustment, final_score,
        status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, 9, 9, 0, 9, ?, ?, ?, '{}', ?, ?)
    `,
    )
    .run(
      input.slug,
      input.title,
      input.thesis,
      input.lifecycle_stage === 'rejected' ? 'archived' : 'active',
      input.lifecycle_stage ?? 'scored',
      input.cluster_key,
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

function insertSource(db: Database.Database, external_id: string): number {
  const now = '2026-06-01T00:00:00.000Z';
  const result = db
    .prepare(
      `
      INSERT INTO source_items (
        source, external_id, title, text, timestamp_utc, ingested_at_utc, raw_path, content_hash
      ) VALUES ('reddit', ?, 'source', 'Manual reconciliation pain', ?, ?, '/tmp/raw.json', ?)
    `,
    )
    .run(external_id, now, now, `hash-${external_id}`);
  return Number(result.lastInsertRowid);
}

describe('findRejectedDuplicate', () => {
  it('treats a candidate sharing source evidence with a rejected opportunity as duplicate', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const rejectedId = insertOpportunity(db, {
      cluster_key: 'invoice-reconciliation',
      lifecycle_stage: 'rejected',
      slug: 'invoice-reconciliation-tool',
      thesis: 'Finance teams waste hours reconciling invoices.',
      title: 'Invoice reconciliation tool',
    });
    const candidateId = insertOpportunity(db, {
      cluster_key: 'invoice-reconciliation',
      slug: 'invoice-reconciliation-helper',
      thesis: 'Teams waste time matching invoices manually.',
      title: 'Invoice reconciliation helper',
    });
    const sourceId = insertSource(db, 'shared');
    db.prepare('INSERT INTO opportunity_sources (opportunity_id, source_item_id) VALUES (?, ?)').run(rejectedId, sourceId);
    db.prepare('INSERT INTO opportunity_sources (opportunity_id, source_item_id) VALUES (?, ?)').run(candidateId, sourceId);

    const result = findRejectedDuplicate(db, {
      cluster_key: 'invoice-reconciliation',
      id: candidateId,
      slug: 'invoice-reconciliation-helper',
      thesis: 'Teams waste time matching invoices manually.',
      title: 'Invoice reconciliation helper',
    });

    expect(result.duplicate).toBe(true);
    expect(result.matchedSlug).toBe('invoice-reconciliation-tool');
    expect(result.sharedSourceIds).toEqual([sourceId]);
    expect(result.reasons).toContain('shared_rejected_source');
  });

  it('matches highly similar rejected opportunity text without shared sources', () => {
    const db = new Database(':memory:');
    initSchema(db);
    insertOpportunity(db, {
      cluster_key: 'invoice-reconciliation',
      lifecycle_stage: 'rejected',
      slug: 'invoice-reconciliation-tool',
      thesis: 'Finance teams waste hours reconciling invoices manually every week.',
      title: 'Invoice reconciliation automation',
    });

    const result = findRejectedDuplicate(db, {
      cluster_key: 'invoice-reconciliation',
      id: 999,
      slug: 'invoice-reconciliation-helper',
      thesis: 'Finance teams waste hours on manual invoice reconciliation every week.',
      title: 'Invoice reconciliation helper',
    });

    expect(result.duplicate).toBe(true);
    expect(result.similarity).toBeGreaterThan(0.55);
    expect(result.reasons).toContain('similar_to_rejected');
  });

  it('does not match unrelated opportunities with generic words', () => {
    const db = new Database(':memory:');
    initSchema(db);
    insertOpportunity(db, {
      cluster_key: 'travel-planning',
      lifecycle_stage: 'rejected',
      slug: 'travel-planning-app',
      thesis: 'Travel planning is annoying for families booking trips.',
      title: 'Travel planning app',
    });

    const result = findRejectedDuplicate(db, {
      cluster_key: 'invoice-reconciliation',
      id: 999,
      slug: 'invoice-reconciliation-helper',
      thesis: 'Finance teams waste hours on manual invoice reconciliation.',
      title: 'Invoice reconciliation helper',
    });

    expect(result.duplicate).toBe(false);
  });
});
