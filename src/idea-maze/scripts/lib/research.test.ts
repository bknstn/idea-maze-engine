import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEvidenceExcerpt } from './evidence-excerpts.ts';

const mocks = vi.hoisted(() => ({
  generateResearchJson: vi.fn(),
}));

const validResearchDraft = {
  thesis: 'Invoice reconciliation is painful.',
  evidence_from_inbox: ['None'],
  evidence_from_telegram: ['None'],
  evidence_from_reddit: ['Manual reconciliation keeps showing up.'],
  external_market_check: ['Existing tools are too broad.'],
  product_concept: 'Finance ops workflow app',
  mvp_scope: ['Core workflow'],
  implementation_plan: ['Ship the narrow slice'],
  distribution_plan: ['Finance ops communities'],
  risks: ['Incumbents'],
};

vi.mock('./llm.ts', () => ({
  generateResearchJson: mocks.generateResearchJson,
  getMissingLlmReason: () => 'LLM provider "openai" is not configured',
  getResearchModel: () => 'gpt-5.6-terra',
  isLlmConfigured: () => true,
}));

describe('researchOpportunity', () => {
  let ideaMazeHome: string;

  beforeEach(() => {
    ideaMazeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-research-'));
    fs.mkdirSync(path.join(ideaMazeHome, 'data'), { recursive: true });
    process.env.IDEA_MAZE_HOME = ideaMazeHome;
    vi.resetModules();
    mocks.generateResearchJson.mockReset();
  });

  afterEach(async () => {
    const { closeDb } = await import('./db.ts');
    closeDb();
    delete process.env.IDEA_MAZE_HOME;
    fs.rmSync(ideaMazeHome, { recursive: true, force: true });
  });

  it('sends exact tail quotes for every grounded role and excludes stale quotes from verified context', async () => {
    mocks.generateResearchJson.mockResolvedValue(validResearchDraft);
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { researchOpportunity } = await import('./research.ts');
    const db = getDb();
    initSchema(db);
    const now = '2026-09-24T00:00:00.000Z';
    const opportunityId = Number(db.prepare(`
      INSERT INTO opportunities (slug,title,thesis,score,market_score,taste_adjustment,final_score,status,lifecycle_stage,cluster_key,metadata_json,created_at_utc,updated_at_utc)
      VALUES ('finance-ops','Finance Ops','Teams reconcile invoices by hand.',8,8,0,8,'active','shortlisted','finance-ops','{}',?,?)
    `).run(now, now).lastInsertRowid);

    const pain = 'At the end of the post, I hate chasing every receipt.';
    const workaround = 'At the end, I copy payments into a spreadsheet.';
    const wtp = 'At the end, I would pay for a reliable fix.';
    const timeLoss = 'At the end, this wastes three hours each Friday.';
    const tail = `${pain} ${workaround} ${wtp} ${timeLoss}`;
    const insertSource = db.prepare(`
      INSERT INTO source_items (source,external_id,title,text,canonical_url,channel_or_label,timestamp_utc,ingested_at_utc,raw_path,content_hash,metadata_json)
      VALUES ('reddit',?,'Invoice post',?,'https://reddit.example/post/1','finance-ops',?,?, '/tmp/source.json','ingest-hash','{}')
    `);
    const goodText = `Opening context. ${'A long unrelated discussion. '.repeat(250)}${tail}`;
    const goodId = Number(insertSource.run('finance-good', goodText, now, now).lastInsertRowid);
    const validExcerpts = [
      ['pain', pain], ['workaround', workaround], ['wtp', wtp], ['time_loss', timeLoss],
    ].map(([role, quote]) => createEvidenceExcerpt({
      sourceItemId: goodId,
      role: role as 'pain' | 'workaround' | 'wtp' | 'time_loss',
      sourceText: goodText,
      candidate: quote,
    })!);
    db.prepare('INSERT INTO opportunity_sources (opportunity_id,source_item_id) VALUES (?,?)').run(opportunityId, goodId);
    db.prepare(`
      INSERT INTO insights (source_item_id,insight_type,summary,evidence_score,confidence,status,metadata_json,created_at_utc)
      VALUES (?,'pain_point','Direct evidence',0.9,0.9,'new',?,?)
    `).run(goodId, JSON.stringify({
      evidence_excerpt_version: 1,
      evidence_excerpt_coverage: 'complete',
      evidence_excerpt_candidate_count: validExcerpts.length,
      evidence_excerpt_rejected_count: 0,
      evidence_excerpts: validExcerpts,
    }), now);

    const oldText = 'Old body: VERIFIED_STALE_RESEARCH_SNIPPET is from the previous version.';
    const currentText = 'Edited body: this sentence replaced the old source content.';
    const staleId = Number(insertSource.run('finance-stale', currentText, now, now).lastInsertRowid);
    const staleExcerpt = createEvidenceExcerpt({
      sourceItemId: staleId,
      role: 'pain',
      sourceText: oldText,
      candidate: 'VERIFIED_STALE_RESEARCH_SNIPPET',
    })!;
    db.prepare('INSERT INTO opportunity_sources (opportunity_id,source_item_id) VALUES (?,?)').run(opportunityId, staleId);
    db.prepare(`
      INSERT INTO insights (source_item_id,insight_type,summary,evidence_score,confidence,status,metadata_json,created_at_utc)
      VALUES (?,'pain_point','Old evidence',0.9,0.9,'new',?,?)
    `).run(staleId, JSON.stringify({
      evidence_excerpt_version: 1,
      evidence_excerpt_coverage: 'complete',
      evidence_excerpt_candidate_count: 1,
      evidence_excerpt_rejected_count: 0,
      evidence_excerpts: [staleExcerpt],
    }), now);

    await researchOpportunity('finance-ops', { db, logger: { log() {}, warn() {} }, requestedBy: 'system' });
    const prompt = String(mocks.generateResearchJson.mock.calls[0][1]);
    expect(prompt).toContain(`⟦${pain}⟧`);
    expect(prompt).toContain(`⟦${workaround}⟧`);
    expect(prompt).toContain(`⟦${wtp}⟧`);
    expect(prompt).toContain(`⟦${timeLoss}⟧`);
    expect(prompt).toContain('Stored excerpt failed source-text revalidation');
    expect(prompt).not.toContain('⟦VERIFIED_STALE_RESEARCH_SNIPPET⟧');
  });

  it('leaves generated research at the review gate instead of publishing an artifact', async () => {
    mocks.generateResearchJson.mockResolvedValue(validResearchDraft);

    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { researchOpportunity } = await import('./research.ts');

    const db = getDb();
    initSchema(db);

    db.prepare(
      `
      INSERT INTO opportunities (slug, title, thesis, score, status, cluster_key, metadata_json, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'finance-ops',
      'Finance Ops',
      'Teams keep reconciling invoices by hand.',
      8,
      'active',
      'finance-ops',
      '{}',
      '2026-04-15T06:00:00.000Z',
      '2026-04-15T06:00:00.000Z',
    );

    const result = await researchOpportunity('finance-ops', {
      db,
      logger: { log() {}, warn() {} },
      requestedBy: 'system',
    });

    expect(result.status).toBe('review_gate');
    expect(result.artifactPath).toBeUndefined();

    const run = db
      .prepare(
        `
      SELECT status, completed_at_utc, metadata_json, error
      FROM runs
      ORDER BY id DESC
      LIMIT 1
    `,
      )
      .get() as {
      completed_at_utc: string | null;
      error: string | null;
      metadata_json: string;
      status: string;
    };
    const opportunity = db
      .prepare('SELECT lifecycle_stage FROM opportunities WHERE slug = ?')
      .get('finance-ops') as { lifecycle_stage: string };

    expect(run.status).toBe('review_gate');
    expect(run.completed_at_utc).toBeNull();
    expect(run.error).toBeNull();
    expect(opportunity.lifecycle_stage).toBe('review_gate');

    const metadata = JSON.parse(run.metadata_json) as {
      prompt_metadata: { validation_status: string };
    };
    expect(metadata.prompt_metadata.validation_status).toBe('valid');
  });

  it('quarantines fallback template drafts away from the review gate without publishing', async () => {
    mocks.generateResearchJson.mockRejectedValue(
      new Error('OpenAI API request timed out after 120000ms'),
    );

    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { researchOpportunity } = await import('./research.ts');

    const db = getDb();
    initSchema(db);

    db.prepare(
      `
      INSERT INTO opportunities (slug, title, thesis, score, status, cluster_key, metadata_json, created_at_utc, updated_at_utc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'finance-ops',
      'Finance Ops',
      'Teams keep reconciling invoices by hand.',
      8,
      'active',
      'finance-ops',
      '{}',
      '2026-04-15T06:00:00.000Z',
      '2026-04-15T06:00:00.000Z',
    );

    const result = await researchOpportunity('finance-ops', {
      db,
      logger: { log() {}, warn() {} },
      requestedBy: 'system',
    });

    expect(result.status).toBe('needs_more_evidence');

    const run = db
      .prepare(
        `
      SELECT status, metadata_json, error
      FROM runs
      ORDER BY id DESC
      LIMIT 1
    `,
      )
      .get() as { error: string | null; metadata_json: string; status: string };

    const metadata = JSON.parse(run.metadata_json) as {
      draft: {
        product_concept: string;
        thesis: string;
      };
      prompt_metadata: {
        validation_status: string;
      };
    };

    const opportunity = db
      .prepare('SELECT lifecycle_stage, status, metadata_json FROM opportunities WHERE slug = ?')
      .get('finance-ops') as {
      lifecycle_stage: string;
      metadata_json: string;
      status: string;
    };

    expect(run.status).toBe('needs_more_evidence');
    expect(run.error).toBeNull();
    expect(opportunity.lifecycle_stage).toBe('archived');
    expect(opportunity.status).toBe('archived');
    expect(metadata.draft.thesis).toBe(
      'Teams keep reconciling invoices by hand.',
    );
    expect(metadata.draft.product_concept).toContain('finance-ops');
    expect(metadata.prompt_metadata.validation_status).toBe(
      'fallback_template',
    );
  });
});
