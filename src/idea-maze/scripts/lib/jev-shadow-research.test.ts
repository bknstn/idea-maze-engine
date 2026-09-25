import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const validQuestions = {
  tailquote_grounding: { type: 'noul', noul: 0.8 },
  workaround_signal: { type: 'noul', noul: 0.6 },
  contradiction_signal: { type: 'noul', noul: 0.1 },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('research Jev shadow cache', () => {
  let ideaMazeHome: string;

  beforeEach(() => {
    ideaMazeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-jev-'));
    fs.mkdirSync(path.join(ideaMazeHome, 'data'), { recursive: true });
    vi.stubEnv('IDEA_MAZE_HOME', ideaMazeHome);
    vi.stubEnv('IDEA_MAZE_JEV_ENABLED', 'false');
    vi.stubEnv('IDEA_MAZE_JEV_MODEL', '');
    vi.stubEnv('TYPESAFE_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import('./db.ts');
    closeDb();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(ideaMazeHome, { recursive: true, force: true });
  });

  it('stays disabled with zero fetches and preserves verified evidence state', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const { db, opportunity, sourceItems, sourceText, quote } = await createEvidenceFixture();
    const { assessResearchEvidenceWithJev } = await import('./jev-shadow-research.ts');

    const trace = await assessResearchEvidenceWithJev(db, opportunity, sourceItems);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(trace).toMatchObject({
      enabled: false,
      applied_to_decision: false,
      eligible_source_count: 1,
      skipped_count: 1,
      cache_hits: 0,
    });
    expect(sourceItems[0].text).toBe(sourceText);
    expect(sourceItems[0].evidence_excerpts[0].quote).toBe(quote);
  });

  it('uses cache hits without fetch, then invalidates on full-text hash and model change', async () => {
    vi.stubEnv('IDEA_MAZE_JEV_ENABLED', 'true');
    vi.stubEnv('IDEA_MAZE_JEV_MODEL', 'account-model-a');
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const fetchMock = vi.fn<typeof fetch>(async () => response({
      model: 'returned-model-a',
      answers: validQuestions,
      usage: { input_tokens: 52, output_tokens: 7 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { db, opportunity, sourceItems, sourceText, quote, sourceId } = await createEvidenceFixture();
    const { assessResearchEvidenceWithJev } = await import('./jev-shadow-research.ts');

    const first = await assessResearchEvidenceWithJev(db, opportunity, sourceItems);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.entries[0].dimensions.map((dimension) => dimension.dimension)).toEqual([
      'tailquote', 'workaround', 'contradiction',
    ]);
    expect(first.entries[0].dimensions[0]).toMatchObject({ status: 'scored', noul: 0.8 });
    expect(first.entries[0].full_source_version_hash).toBe((await import('./evidence-excerpts.ts')).hashSourceText(sourceText));
    expect(first.token_usage).toEqual({ input_tokens: 52, output_tokens: 7 });
    expect(first.entries[0].usage_source).toBe('provider_call');

    const second = await assessResearchEvidenceWithJev(db, opportunity, sourceItems);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.cache_hits).toBe(1);
    expect(second.entries[0]).toMatchObject({ cache_hit: true, usage_source: 'cached_original' });
    expect(second.token_usage).toEqual({ input_tokens: null, output_tokens: null });
    expect(second.entries[0].usage.input_tokens).toBe(52);

    const { createEvidenceExcerpt, hashSourceText } = await import('./evidence-excerpts.ts');
    const changedText = `${sourceText} Added context after the verified evidence.`;
    const changedExcerpt = createEvidenceExcerpt({
      sourceItemId: sourceId,
      role: 'pain',
      sourceText: changedText,
      candidate: quote,
    })!;
    db.prepare('UPDATE source_items SET text = ? WHERE id = ?').run(changedText, sourceId);
    db.prepare('UPDATE insights SET metadata_json = ? WHERE source_item_id = ?').run(JSON.stringify({
      evidence_excerpt_version: 1,
      evidence_excerpt_coverage: 'complete',
      evidence_excerpts: [changedExcerpt],
    }), sourceId);
    vi.resetModules();
    const { loadOpportunitySourceEvidence } = await import('./source-evidence.ts');
    const refreshedSources = loadOpportunitySourceEvidence(db, opportunity.id);
    const afterTextChange = await (await import('./jev-shadow-research.ts')).assessResearchEvidenceWithJev(db, opportunity, refreshedSources);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(afterTextChange.cache_hits).toBe(0);
    expect(afterTextChange.entries[0].full_source_version_hash).toBe(hashSourceText(changedText));

    vi.stubEnv('IDEA_MAZE_JEV_MODEL', 'account-model-b');
    vi.resetModules();
    const afterModelChange = await (await import('./jev-shadow-research.ts')).assessResearchEvidenceWithJev(db, opportunity, refreshedSources);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(afterModelChange.entries[0].requested_model).toBe('account-model-b');
    expect(afterModelChange.entries[0].cache_hit).toBe(false);

    const keysAndCache = db.prepare("SELECT key, value_json FROM app_state WHERE key LIKE 'research:jev-shadow:v1:%'").all() as Array<{ key: string; value_json: string }>;
    expect(keysAndCache).toHaveLength(3);
    expect(keysAndCache.every((row) => !row.value_json.includes(quote))).toBe(true);
  });

  it('marks malformed scores unknown and does not cache them', async () => {
    vi.stubEnv('IDEA_MAZE_JEV_ENABLED', 'true');
    vi.stubEnv('IDEA_MAZE_JEV_MODEL', 'account-model-a');
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const fetchMock = vi.fn<typeof fetch>(async () => response({
      model: 'returned-model-a',
      answers: {
        ...validQuestions,
        tailquote_grounding: { type: 'noul', noul: 1.4 },
      },
      usage: { input_tokens: 12, output_tokens: 2 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { db, opportunity, sourceItems } = await createEvidenceFixture();
    const { assessResearchEvidenceWithJev } = await import('./jev-shadow-research.ts');

    const trace = await assessResearchEvidenceWithJev(db, opportunity, sourceItems);
    expect(trace.entries[0].dimensions[0]).toMatchObject({ status: 'unknown', noul: null });
    expect(trace.entries[0].status).toBe('partial');
    expect(db.prepare("SELECT COUNT(*) as count FROM app_state WHERE key LIKE 'research:jev-shadow:v1:%'").get()).toMatchObject({ count: 0 });
  });

  it('fails open on corrupted cache and cache write errors', async () => {
    vi.stubEnv('IDEA_MAZE_JEV_ENABLED', 'true');
    vi.stubEnv('IDEA_MAZE_JEV_MODEL', 'account-model-a');
    vi.stubEnv('TYPESAFE_API_KEY', 'test-key');
    const fetchMock = vi.fn<typeof fetch>(async () => response({
      model: 'returned-model-a', answers: validQuestions, usage: { input_tokens: 12, output_tokens: 2 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { db, opportunity, sourceItems } = await createEvidenceFixture();
    const { assessResearchEvidenceWithJev } = await import('./jev-shadow-research.ts');
    const first = await assessResearchEvidenceWithJev(db, opportunity, sourceItems);
    const cacheKey = first.entries[0].cache_key!;
    db.prepare('UPDATE app_state SET value_json = ? WHERE key = ?').run('{not-json', `research:jev-shadow:v1:${cacheKey}`);

    const afterCorruption = await assessResearchEvidenceWithJev(db, opportunity, sourceItems);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(afterCorruption.cache_read_failures).toBe(1);
    expect(afterCorruption.entries[0].status).toBe('complete');

    db.exec(`CREATE TRIGGER fail_jev_cache_insert BEFORE INSERT ON app_state
      WHEN NEW.key LIKE 'research:jev-shadow:v1:%'
      BEGIN SELECT RAISE(ABORT, 'synthetic cache write failure'); END;`);
    const changedText = `${sourceItems[0].text} Another context change.`;
    const sourceId = sourceItems[0].id;
    const { createEvidenceExcerpt } = await import('./evidence-excerpts.ts');
    const quote = sourceItems[0].evidence_excerpts[0].quote;
    const excerpt = createEvidenceExcerpt({ sourceItemId: sourceId, role: 'pain', sourceText: changedText, candidate: quote })!;
    db.prepare('UPDATE source_items SET text = ? WHERE id = ?').run(changedText, sourceId);
    db.prepare('UPDATE insights SET metadata_json = ? WHERE source_item_id = ?').run(JSON.stringify({
      evidence_excerpt_version: 1,
      evidence_excerpt_coverage: 'complete',
      evidence_excerpts: [excerpt],
    }), sourceId);
    vi.resetModules();
    const refreshedSources = (await import('./source-evidence.ts')).loadOpportunitySourceEvidence(db, opportunity.id);
    const writeFailureTrace = await (await import('./jev-shadow-research.ts')).assessResearchEvidenceWithJev(db, opportunity, refreshedSources);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(writeFailureTrace.entries[0].status).toBe('complete');
    expect(writeFailureTrace.cache_write_failures).toBe(1);
  });
});

async function createEvidenceFixture(): Promise<{
  db: import('better-sqlite3').Database;
  opportunity: { id: number; title: string; thesis: string; cluster_key: string };
  sourceItems: import('./source-evidence.ts').OpportunitySourceEvidence[];
  sourceId: number;
  sourceText: string;
  quote: string;
}> {
  const { getDb } = await import('./db.ts');
  const { initSchema } = await import('./schema.ts');
  const { createEvidenceExcerpt } = await import('./evidence-excerpts.ts');
  const { loadOpportunitySourceEvidence } = await import('./source-evidence.ts');
  const db = getDb();
  initSchema(db);
  const now = '2026-09-25T00:00:00.000Z';
  const opportunity: { id: number; title: string; thesis: string; cluster_key: string } = {
    id: Number(db.prepare(`
      INSERT INTO opportunities (slug,title,thesis,score,market_score,taste_adjustment,final_score,status,lifecycle_stage,cluster_key,metadata_json,created_at_utc,updated_at_utc)
      VALUES ('jev-test','Receipt reconciliation','Teams need help reconciling receipts.',8,8,0,8,'active','shortlisted','receipt-reconciliation','{}',?,?)
    `).run(now, now).lastInsertRowid),
    title: 'Receipt reconciliation',
    thesis: 'Teams need help reconciling receipts.',
    cluster_key: 'receipt-reconciliation',
  };
  const quote = 'At the very end, I hate manually matching receipts every Friday.';
  const sourceText = `Opening context. ${'A long unrelated discussion. '.repeat(180)}${quote}`;
  const sourceId = Number(db.prepare(`
    INSERT INTO source_items (source,external_id,title,text,canonical_url,channel_or_label,timestamp_utc,ingested_at_utc,raw_path,content_hash,metadata_json)
    VALUES ('reddit','jev-source-1','Receipt thread',?,'https://reddit.example/thread/1','finance',?,?, '/tmp/jev-source.json','ingest-hash','{}')
  `).run(sourceText, now, now).lastInsertRowid);
  const excerpt = createEvidenceExcerpt({ sourceItemId: sourceId, role: 'pain', sourceText, candidate: quote })!;
  db.prepare('INSERT INTO opportunity_sources (opportunity_id,source_item_id) VALUES (?,?)').run(opportunity.id, sourceId);
  db.prepare(`
    INSERT INTO insights (source_item_id,insight_type,summary,evidence_score,confidence,status,metadata_json,created_at_utc)
    VALUES (?,'pain_point','Direct evidence',0.9,0.9,'new',?,?)
  `).run(sourceId, JSON.stringify({
    evidence_excerpt_version: 1,
    evidence_excerpt_coverage: 'complete',
    evidence_excerpts: [excerpt],
  }), now);
  return {
    db,
    opportunity,
    sourceItems: loadOpportunitySourceEvidence(db, opportunity.id),
    sourceId,
    sourceText,
    quote,
  };
}
