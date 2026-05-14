import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateResearchJson: vi.fn(),
  publishResearchArtifact: vi.fn(),
}));

vi.mock('./llm.ts', () => ({
  RESEARCH_MODEL: 'claude-sonnet-4-6',
  generateResearchJson: mocks.generateResearchJson,
  isLlmConfigured: () => true,
}));

vi.mock('./review.ts', () => ({
  publishResearchArtifact: mocks.publishResearchArtifact,
}));

describe('researchOpportunity', () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-research-'));
    fs.mkdirSync(path.join(groupDir, 'data'), { recursive: true });
    process.env.WORKSPACE_GROUP = groupDir;
    vi.resetModules();
    mocks.generateResearchJson.mockReset();
    mocks.publishResearchArtifact.mockReset();
    mocks.publishResearchArtifact.mockReturnValue({
      path: path.join(groupDir, 'data', 'artifacts', 'finance-ops.md'),
    });
  });

  afterEach(async () => {
    const { closeDb } = await import('./db.ts');
    closeDb();
    delete process.env.WORKSPACE_GROUP;
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('marks the run as error when artifact publication fails after the run starts', async () => {
    mocks.generateResearchJson.mockResolvedValue({
      thesis: 'T',
      evidence_from_inbox: ['None'],
      evidence_from_telegram: ['None'],
      evidence_from_reddit: ['None'],
      external_market_check: ['None'],
      product_concept: 'P',
      mvp_scope: ['MVP'],
      implementation_plan: ['Plan'],
      distribution_plan: ['Dist'],
      risks: ['Risk'],
    });
    mocks.publishResearchArtifact.mockImplementation(() => {
      throw new Error('publish failed');
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
      'span-comments',
      'Span Comments',
      'AI agents need clearer specs.',
      10,
      'active',
      'span-comments',
      '{}',
      '2026-04-15T06:00:00.000Z',
      '2026-04-15T06:00:00.000Z',
    );

    await expect(
      researchOpportunity('span-comments', {
        db,
        logger: { log() {}, warn() {} },
        requestedBy: 'system',
      }),
    ).rejects.toThrow('publish failed');

    const run = db
      .prepare(
        `
      SELECT status, completed_at_utc, error
      FROM runs
      ORDER BY id DESC
      LIMIT 1
    `,
      )
      .get() as {
      completed_at_utc: string | null;
      error: string | null;
      status: string;
    };

    expect(run.status).toBe('error');
    expect(run.completed_at_utc).not.toBeNull();
    expect(run.error).toContain('publish failed');
  });

  it('falls back to a template draft when the LLM draft request fails', async () => {
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

    expect(result.status).toBe('published');

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

    expect(run.status).toBe('draft_ready');
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
