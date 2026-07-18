import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { findOpportunityDuplicate, findRejectedDuplicate } from './duplicate-opportunities.ts';
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
  it('selects an approved canonical before an active same-thesis candidate', () => {
    const db = new Database(':memory:'); initSchema(db);
    const active = insertOpportunity(db, { cluster_key: 'addiction-recovery', slug: 'out-know', title: 'Recovery knowledge companion', thesis: 'People in addiction recovery need guided support.' });
    const approved = insertOpportunity(db, { cluster_key: 'addiction-recovery', lifecycle_stage: 'approved', slug: 'out-people', title: 'Recovery people support', thesis: 'People in addiction recovery need guided peer support.' });
    db.prepare("UPDATE opportunities SET status='active' WHERE id=?").run(approved);
    const result = findOpportunityDuplicate(db, { id: active, cluster_key: 'addiction-recovery', slug: 'out-know', title: 'Recovery knowledge companion', thesis: 'People in addiction recovery need guided support.' });
    expect(result.duplicate).toBe(true);
    expect(result.matchedOpportunityId).toBe(approved);
    expect(result.matchedLifecycleStage).toBe('approved');
    expect(result.action).toBe('attach_to_approved');
  });

  it('never marks the oldest active row as a duplicate of a newer peer', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const oldest = insertOpportunity(db, {
      cluster_key: 'client-docs',
      slug: 'client-docs-oldest',
      title: 'Client document collection',
      thesis: 'Bookkeepers need guided client document collection.',
    });
    const newer = insertOpportunity(db, {
      cluster_key: 'client-docs',
      slug: 'client-docs-newer',
      title: 'Client document collection workflow',
      thesis: 'Bookkeepers need guided client document collection.',
    });

    const oldestResult = findOpportunityDuplicate(db, {
      id: oldest,
      cluster_key: 'client-docs',
      slug: 'client-docs-oldest',
      title: 'Client document collection',
      thesis: 'Bookkeepers need guided client document collection.',
    });
    const newerResult = findOpportunityDuplicate(db, {
      id: newer,
      cluster_key: 'client-docs',
      slug: 'client-docs-newer',
      title: 'Client document collection workflow',
      thesis: 'Bookkeepers need guided client document collection.',
    });

    expect(oldestResult.duplicate).toBe(false);
    expect(newerResult.matchedOpportunityId).toBe(oldest);
  });

  it('collapses all three same-batch addiction-recovery variants onto the oldest active canonical', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const canonical = insertOpportunity(db, {
      cluster_key: 'addiction-recovery',
      slug: 'out-know',
      title: 'Addiction recovery guided support',
      thesis: 'People in addiction recovery need guided support.',
    });
    insertOpportunity(db, {
      cluster_key: 'addiction-recovery',
      lifecycle_stage: 'rejected',
      slug: 'out-people',
      title: 'Addiction recovery guided people support',
      thesis: 'People in addiction recovery need guided support.',
    });
    const pipeline = insertOpportunity(db, {
      cluster_key: 'addiction-recovery',
      slug: 'out-pipeline',
      title: 'Addiction recovery guided support pipeline',
      thesis: 'People in addiction recovery need guided support.',
    });

    const result = findOpportunityDuplicate(db, {
      id: pipeline,
      cluster_key: 'addiction-recovery',
      slug: 'out-pipeline',
      title: 'Addiction recovery guided support pipeline',
      thesis: 'People in addiction recovery need guided support.',
    });

    expect(result.duplicate).toBe(true);
    expect(result.matchedOpportunityId).toBe(canonical);
    expect(result.action).toBe('attach_to_active');
  });

  it('matches equivalent normalized source crossposts with different hashes', () => {
    const db = new Database(':memory:'); initSchema(db);
    const canonical = insertOpportunity(db, { cluster_key: 'client-docs', lifecycle_stage: 'review_gate', slug: 'client-docs', title: 'Client document collection', thesis: 'Bookkeepers chase client documents.' });
    const candidate = insertOpportunity(db, { cluster_key: 'document-chasing', slug: 'bookkeeper-chasing', title: 'Bookkeeper document chasing', thesis: 'Accountants chase missing customer paperwork.' });
    const now = '2026-06-01T00:00:00.000Z';
    const add = (external: string, text: string, hash: string) => Number(db.prepare("INSERT INTO source_items (source,external_id,title,text,timestamp_utc,ingested_at_utc,raw_path,content_hash) VALUES ('reddit',?,'same',?,?,?,'/tmp/x',?)").run(external,text,now,now,hash).lastInsertRowid);
    const a = add('a', 'I hate chasing missing client documents every Friday!', 'different-a');
    const b = add('b', 'I hate chasing missing client documents every Friday.', 'different-b');
    db.prepare('INSERT INTO opportunity_sources (opportunity_id, source_item_id) VALUES (?,?)').run(canonical, a);
    db.prepare('INSERT INTO opportunity_sources (opportunity_id, source_item_id) VALUES (?,?)').run(candidate, b);
    const result = findOpportunityDuplicate(db, { id: candidate, cluster_key: 'document-chasing', slug: 'bookkeeper-chasing', title: 'Bookkeeper document chasing', thesis: 'Accountants chase missing customer paperwork.' });
    expect(result.duplicate).toBe(true);
    expect(result.reasons).toContain('shared_source_signature');
  });
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
