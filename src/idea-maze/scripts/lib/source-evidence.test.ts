import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createEvidenceExcerpt } from './evidence-excerpts.ts';
import { initSchema } from './schema.ts';
import {
  formatSourceEvidence,
  loadOpportunitySourceEvidence,
  type OpportunitySourceEvidence,
} from './source-evidence.ts';

const now = '2026-09-24T00:00:00.000Z';

function sourceFixture(text: string, overrides: Partial<OpportunitySourceEvidence> = {}): OpportunitySourceEvidence {
  return {
    id: 1,
    source: 'reddit',
    external_id: 'post-1',
    thread_ref: 'thread-1',
    author: null,
    title: 'Evidence source',
    text,
    canonical_url: 'https://reddit.example/r/test/comments/1',
    channel_or_label: 'test-community',
    timestamp_utc: now,
    ingested_at_utc: now,
    raw_path: '/tmp/source.json',
    content_hash: 'ingestion-hash-may-include-title',
    sensitivity: 'normal',
    metadata_json: '{}',
    evidence_excerpts: [],
    evidence_excerpt_coverage: 'unknown',
    evidence_excerpt_status: 'legacy',
    invalid_evidence_excerpt_count: 0,
    ...overrides,
  };
}

function makeDb() {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

function insertLinkedSource(
  db: Database.Database,
  input: { text: string; metadata: Record<string, unknown>; externalId?: string },
): { opportunityId: number; sourceItemId: number } {
  const opportunityId = Number(db.prepare(`
    INSERT INTO opportunities (slug,title,thesis,score,market_score,taste_adjustment,final_score,status,lifecycle_stage,cluster_key,metadata_json,created_at_utc,updated_at_utc)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(`opp-${input.externalId ?? '1'}`, 'Test', 'Test thesis', 5, 5, 0, 5, 'active', 'shortlisted', 'test', '{}', now, now).lastInsertRowid);
  const sourceItemId = Number(db.prepare(`
    INSERT INTO source_items (source,external_id,title,text,canonical_url,channel_or_label,timestamp_utc,ingested_at_utc,raw_path,content_hash,metadata_json)
    VALUES ('reddit',?,'Title',?,?, 'test-community',?,?, '/tmp/source.json','ingestion-hash','{}')
  `).run(input.externalId ?? 'post-1', input.text, 'https://reddit.example/r/test/comments/1', now, now).lastInsertRowid);
  db.prepare('INSERT INTO opportunity_sources (opportunity_id,source_item_id) VALUES (?,?)').run(opportunityId, sourceItemId);
  db.prepare(`
    INSERT INTO insights (source_item_id,insight_type,summary,evidence_score,confidence,status,metadata_json,created_at_utc)
    VALUES (?,'pain_point','Test insight',0.8,0.8,'new',?,?)
  `).run(sourceItemId, JSON.stringify(input.metadata), now);
  return { opportunityId, sourceItemId };
}

describe('source evidence packet formatting', () => {
  it('keeps multiple verified roles and the exact quote within the shared prompt budget', () => {
    const text = 'Pain: I hate chasing receipts. Workaround: I use a spreadsheet. WTP: I would pay for a fix. Time: this wastes two hours every week.';
    const roles = [
      ['pain', 'I hate chasing receipts.'],
      ['workaround', 'I use a spreadsheet.'],
      ['wtp', 'I would pay for a fix.'],
      ['time_loss', 'this wastes two hours every week.'],
    ] as const;
    const evidence = sourceFixture(text, {
      evidence_excerpt_coverage: 'complete',
      evidence_excerpts: roles.map(([role, candidate]) => createEvidenceExcerpt({
        sourceItemId: 1,
        role,
        sourceText: text,
        candidate,
      })!),
    });

    const formatted = formatSourceEvidence(evidence, 600);
    expect(formatted.length).toBeLessThanOrEqual(600);
    for (const [role, quote] of roles) {
      expect(formatted).toContain(`Verified ${role} excerpt`);
      expect(formatted).toContain(`⟦${quote}⟧`);
    }
    expect(formatted).toContain(evidence.canonical_url!);
  });

  it('selects one excerpt per role before using the remaining budget for same-role duplicates', () => {
    const text = 'Pain one. Workaround. Willingness to pay. Time cost. Pain duplicate with extra detail.';
    const quotes = [
      ['pain', 'Pain one.'],
      ['pain', 'Pain duplicate with extra detail.'],
      ['workaround', 'Workaround.'],
      ['wtp', 'Willingness to pay.'],
      ['time_loss', 'Time cost.'],
    ] as const;
    const evidence = sourceFixture(text, {
      evidence_excerpt_coverage: 'complete',
      evidence_excerpts: quotes.map(([role, quote]) => createEvidenceExcerpt({
        sourceItemId: 1,
        role,
        sourceText: text,
        candidate: quote,
      })!),
    });
    const formatted = formatSourceEvidence(evidence, 285);
    expect(formatted).toContain('Verified pain excerpt');
    expect(formatted).toContain('Verified workaround excerpt');
    expect(formatted).toContain('Verified wtp excerpt');
    expect(formatted).toContain('Verified time_loss excerpt');
  });

  it('omits an oversized verified quote as a whole and never relabels it as legacy text', () => {
    const text = `The exact long quote is: ${'a'.repeat(300)}`;
    const quote = text.slice(text.indexOf('The exact'), text.length);
    const evidence = sourceFixture(text, {
      evidence_excerpt_coverage: 'complete',
      evidence_excerpts: [createEvidenceExcerpt({
        sourceItemId: 1,
        role: 'pain',
        sourceText: text,
        candidate: quote,
      })!],
    });

    const formatted = formatSourceEvidence(evidence, 140);
    expect(formatted.length).toBeLessThanOrEqual(140);
    expect(formatted).toContain('Verified pain excerpt omitted as a whole');
    expect(formatted).toContain('could not fit this prompt budget');
    expect(formatted).not.toContain('Unverified context only');
    expect(formatted).not.toContain(quote.slice(0, 30));
  });

  it.each([
    ['legacy', 'unknown', 'Legacy source has no stored verified excerpt.'],
    ['no_grounded_evidence', 'complete', 'no grounded quote; no quote is verified'],
    ['no_grounded_evidence', 'sampled', 'no grounded quote; only a partial source sample'],
    ['stale', 'complete', 'failed source-text revalidation'],
  ] as const)('labels %s fallback as unverified context', (status, coverage, label) => {
    const formatted = formatSourceEvidence(sourceFixture('A short source body.', {
      evidence_excerpt_status: status,
      evidence_excerpt_coverage: coverage,
    }), 600);
    expect(formatted.length).toBeLessThanOrEqual(600);
    expect(formatted).toContain(label);
    expect(formatted).toContain('Unverified context only');
    expect(formatted).not.toContain('Verified pain excerpt');
  });
});

describe('stored source excerpt revalidation', () => {
  it('returns verified excerpts only while text hash, source id, and exact offsets still match', () => {
    const db = makeDb();
    const text = 'I hate reconciling invoices by hand every Friday.';
    const excerpt = createEvidenceExcerpt({
      sourceItemId: 1,
      role: 'pain',
      sourceText: text,
      candidate: 'I hate reconciling invoices by hand every Friday.',
    })!;
    const { opportunityId, sourceItemId } = insertLinkedSource(db, {
      text,
      metadata: {
        evidence_excerpt_version: 1,
        evidence_excerpt_coverage: 'complete',
        evidence_excerpt_candidate_count: 1,
        evidence_excerpt_rejected_count: 0,
        evidence_excerpts: [{ ...excerpt, sourceItemId: 1 }],
      },
    });
    db.prepare('UPDATE insights SET metadata_json = ? WHERE source_item_id = ?')
      .run(JSON.stringify({
        evidence_excerpt_version: 1,
        evidence_excerpt_coverage: 'complete',
        evidence_excerpt_candidate_count: 1,
        evidence_excerpt_rejected_count: 0,
        evidence_excerpts: [{ ...excerpt, sourceItemId }],
      }), sourceItemId);

    const current = loadOpportunitySourceEvidence(db, opportunityId);
    expect(current[0].evidence_excerpt_coverage).toBe('complete');
    expect(current[0].evidence_excerpt_status).toBe('verified');
    expect(current[0].evidence_excerpts).toHaveLength(1);
    expect(formatSourceEvidence(current[0])).toContain(`⟦${excerpt.quote}⟧`);

    db.prepare('UPDATE source_items SET text = ? WHERE id = ?').run(`${text} Updated.`, sourceItemId);
    const stale = loadOpportunitySourceEvidence(db, opportunityId);
    expect(stale[0].evidence_excerpt_coverage).toBe('complete');
    expect(stale[0].evidence_excerpt_status).toBe('stale');
    expect(stale[0].evidence_excerpts).toHaveLength(0);
    const formatted = formatSourceEvidence(stale[0]);
    expect(formatted).toContain('failed source-text revalidation');
    expect(formatted).not.toContain(`⟦${excerpt.quote}⟧`);
    expect(formatted).not.toContain('Verified pain excerpt');
    db.close();
  });
});
