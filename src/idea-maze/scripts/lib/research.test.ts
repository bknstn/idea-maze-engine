import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateResearchJson: vi.fn(),
}));

vi.mock('./llm.ts', () => ({
  RESEARCH_MODEL: 'claude-sonnet-4-6',
  generateResearchJson: mocks.generateResearchJson,
  getMissingLlmReason: () =>
    'No configured LLM provider (set ANTHROPIC_API_KEY or OPENAI_API_KEY)',
  getResearchModel: () => 'claude-sonnet-4-6',
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

  it('leaves generated research at the review gate instead of publishing an artifact', async () => {
    mocks.generateResearchJson.mockResolvedValue({
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
    });

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

  it('keeps fallback template drafts at the review gate without publishing', async () => {
    mocks.generateResearchJson.mockRejectedValue(
      new Error('Anthropic API request timed out after 120000ms'),
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

    expect(result.status).toBe('review_gate');

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

    expect(run.status).toBe('review_gate');
    expect(run.error).toBeNull();
    expect(metadata.draft.thesis).toBe(
      'Teams keep reconciling invoices by hand.',
    );
    expect(metadata.draft.product_concept).toContain('finance-ops');
    expect(metadata.prompt_metadata.validation_status).toBe(
      'fallback_template',
    );
  });
});
