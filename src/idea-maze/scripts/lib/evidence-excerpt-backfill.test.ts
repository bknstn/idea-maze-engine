import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { hashSourceText } from './evidence-excerpts.ts';
import { backfillEvidenceExcerpts } from './evidence-excerpt-backfill.ts';
import { initSchema } from './schema.ts';

describe('legacy evidence excerpt backfill', () => {
  it('is dry-run by default, grounds only the historically visible head, and is idempotent', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const now = '2026-09-24T00:00:00.000Z';
    const quote = 'We copy every payment into a spreadsheet each Friday.';
    const beyondLegacyWindow = 'This hidden tail claims someone will pay $500 each month.';
    const sourceText = `${quote} ${'unrelated context. '.repeat(100)} ${beyondLegacyWindow}`;
    const sourceItemId = Number(db.prepare(`
      INSERT INTO source_items (source,external_id,title,text,timestamp_utc,ingested_at_utc,raw_path,content_hash)
      VALUES ('reddit','legacy-1','Old post',?,?,?,'/tmp/old.json','ingest-hash')
    `).run(sourceText, now, now).lastInsertRowid);
    const insightId = Number(db.prepare(`
      INSERT INTO insights (source_item_id,insight_type,summary,evidence_score,confidence,status,metadata_json,created_at_utc)
      VALUES (?,'pain_point','Old insight',0.8,0.8,'new',?,?)
    `).run(sourceItemId, JSON.stringify({
      pain_point: quote,
      current_workaround: quote,
      willingness_to_pay: beyondLegacyWindow,
    }), now).lastInsertRowid);

    const dryRun = backfillEvidenceExcerpts(db, { limit: 10 });
    expect(dryRun).toMatchObject({ dryRun: true, rowsScanned: 1, rowsUpdated: 0, excerptsCreated: 2, excerptsRejected: 1 });
    const beforeApply = JSON.parse((db.prepare('SELECT metadata_json FROM insights WHERE id=?').get(insightId) as { metadata_json: string }).metadata_json);
    expect(beforeApply.evidence_excerpt_version).toBeUndefined();

    const applied = backfillEvidenceExcerpts(db, { apply: true, limit: 10 });
    expect(applied).toMatchObject({ dryRun: false, rowsScanned: 1, rowsUpdated: 1, excerptsCreated: 2, excerptsRejected: 1 });
    const metadata = JSON.parse((db.prepare('SELECT metadata_json FROM insights WHERE id=?').get(insightId) as { metadata_json: string }).metadata_json);
    expect(metadata.evidence_excerpt_coverage).toBe('sampled');
    expect(metadata.evidence_excerpt_backfill).toBe('legacy_metadata_exact_match_v1');
    expect(metadata.evidence_excerpts).toHaveLength(2);
    expect(metadata.evidence_excerpts[0].sourceTextHash).toBe(hashSourceText(sourceText));
    expect(metadata.evidence_excerpts.every((excerpt: { endUtf16: number }) => excerpt.endUtf16 <= 1500)).toBe(true);

    const rerun = backfillEvidenceExcerpts(db, { apply: true, limit: 10 });
    expect(rerun).toMatchObject({ rowsNeedingBackfill: 0, rowsScanned: 0, rowsUpdated: 0, excerptsCreated: 0 });
    db.close();
  });

  it('processes bounded batches in order and reports malformed metadata without overwriting it', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const now = '2026-09-24T00:00:00.000Z';
    const sourceItemId = Number(db.prepare(`
      INSERT INTO source_items (source,external_id,title,text,timestamp_utc,ingested_at_utc,raw_path,content_hash)
      VALUES ('reddit','legacy-batches','Old post','The body contains one exact phrase.',?,?, '/tmp/old.json','ingest-hash')
    `).run(now, now).lastInsertRowid);
    const insertInsight = db.prepare(`
      INSERT INTO insights (source_item_id,insight_type,summary,evidence_score,confidence,status,metadata_json,created_at_utc)
      VALUES (?,'pain_point','Old insight',0.8,0.8,'new',?,?)
    `);
    const firstId = Number(insertInsight.run(sourceItemId, JSON.stringify({ pain_point: 'The body contains one exact phrase.' }), now).lastInsertRowid);
    const secondId = Number(insertInsight.run(sourceItemId, JSON.stringify({ pain_point: 'The body contains one exact phrase.' }), now).lastInsertRowid);
    const malformedId = Number(insertInsight.run(sourceItemId, '{not json', now).lastInsertRowid);

    const firstBatch = backfillEvidenceExcerpts(db, { apply: true, limit: 1 });
    expect(firstBatch).toMatchObject({ rowsNeedingBackfill: 2, rowsScanned: 1, rowsUpdated: 1, rowsSkippedMalformed: 1 });
    expect(JSON.parse((db.prepare('SELECT metadata_json FROM insights WHERE id=?').get(firstId) as { metadata_json: string }).metadata_json).evidence_excerpt_version).toBe(1);
    expect(JSON.parse((db.prepare('SELECT metadata_json FROM insights WHERE id=?').get(secondId) as { metadata_json: string }).metadata_json).evidence_excerpt_version).toBeUndefined();

    const secondBatch = backfillEvidenceExcerpts(db, { apply: true, limit: 1 });
    expect(secondBatch).toMatchObject({ rowsNeedingBackfill: 1, rowsScanned: 1, rowsUpdated: 1, rowsSkippedMalformed: 1 });
    const done = backfillEvidenceExcerpts(db, { apply: true, limit: 1 });
    expect(done).toMatchObject({ rowsNeedingBackfill: 0, rowsScanned: 0, rowsUpdated: 0, rowsSkippedMalformed: 1 });
    expect((db.prepare('SELECT metadata_json FROM insights WHERE id=?').get(malformedId) as { metadata_json: string }).metadata_json).toBe('{not json');
    db.close();
  });

  it('rejects invalid limits rather than removing the SQL bound', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(() => backfillEvidenceExcerpts(db, { limit: Number.POSITIVE_INFINITY })).toThrow('non-negative safe integer');
    expect(() => backfillEvidenceExcerpts(db, { limit: -1 })).toThrow('non-negative safe integer');
    db.close();
  });
});
