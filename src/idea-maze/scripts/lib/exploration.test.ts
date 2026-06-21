import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ValidatedExplorationBrief } from './validation.ts';

const mocks = vi.hoisted(() => ({
  generateExplorationJson: vi.fn(),
}));

vi.mock('./llm.ts', () => ({
  EXPLORATION_MODEL: 'claude-opus-4-5',
  generateExplorationJson: mocks.generateExplorationJson,
  getExplorationModel: () => 'claude-opus-4-5',
  getMissingLlmReason: () => 'No configured LLM provider (set ANTHROPIC_API_KEY or OPENAI_API_KEY)',
  isLlmConfigured: () => true,
}));

const brief: ValidatedExplorationBrief = {
  thesis: 'Managers lose delegated tasks across voice and chat.',
  icp: {
    buyer: 'Owner-manager',
    user: 'Manager',
    trigger: 'After calls or site visits',
    current_workaround: 'WhatsApp and memory',
    budget_owner: 'Owner-manager',
  },
  evidence_summary: [{ source_type: 'reddit', quote_or_summary: 'Need voice-first delegation.', interpretation: 'Direct pain.', evidence_role: 'buyer_pain' }],
  competitor_map: [{ name: 'Todoist', category: 'task manager', positioning: 'General tasks', weakness: 'No delegation confirmation workflow' }],
  workflow_wedge: { narrow_workflow: 'Speak → assign → confirm → follow up', must_have_features: ['voice capture'], explicit_non_goals: ['full PM suite'] },
  interview_script: ['What was the last task that got lost?'],
  smoke_test: { audience: '10-person team managers', offer: 'Voice delegation inbox', channel: 'manual outreach', success_metric: '5 calls / 50 outreaches' },
  pricing_hypothesis: '$29/month',
  kill_criteria: ['<3/10 report weekly pain'],
  open_questions: ['Which channel first?'],
  next_action: 'Interview 10 managers.',
};

function quietLogger() {
  return { log() {}, warn() {} };
}

async function insertOpportunity(db: any, overrides: Record<string, unknown> = {}) {
  const now = '2026-06-21T00:00:00.000Z';
  const row = {
    slug: 'voice-looking',
    title: 'Voice Looking',
    thesis: 'Managers lose delegated tasks.',
    score: 9,
    market_score: 9,
    taste_adjustment: 0,
    final_score: 9,
    status: 'active',
    lifecycle_stage: 'approved',
    cluster_key: 'voice-looking',
    metadata_json: '{}',
    created_at_utc: now,
    updated_at_utc: now,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO opportunities (slug,title,thesis,score,market_score,taste_adjustment,final_score,status,lifecycle_stage,cluster_key,metadata_json,created_at_utc,updated_at_utc)
    VALUES (@slug,@title,@thesis,@score,@market_score,@taste_adjustment,@final_score,@status,@lifecycle_stage,@cluster_key,@metadata_json,@created_at_utc,@updated_at_utc)
  `).run(row);
}

describe('exploration rendering', () => {
  it('renders all required sections with frontmatter', async () => {
    const { renderExplorationMarkdown } = await import('./exploration.ts');
    const markdown = renderExplorationMarkdown(brief, {
      runId: 42,
      opportunitySlug: 'voice-looking',
      createdAtUtc: '2026-06-21T00:00:00.000Z',
    });
    expect(markdown).toContain('run_id: 42');
    expect(markdown).toContain('opportunity_slug: voice-looking');
    expect(markdown).toContain('## ICP');
    expect(markdown).toContain('## Competitor Map');
    expect(markdown).toContain('## Kill Criteria');
    expect(markdown).toContain('Interview 10 managers.');
  });

  it('uses explorations path, not artifacts path', async () => {
    const { explorationRelativePath } = await import('./exploration.ts');
    const date = new Date('2026-06-21T12:00:00.000Z');
    expect(explorationRelativePath('voice-looking', date)).toBe('data/explorations/2026/06/21/voice-looking.md');
  });
});

describe('exploration orchestration', () => {
  let ideaMazeHome: string;

  beforeEach(() => {
    ideaMazeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-explore-'));
    fs.mkdirSync(path.join(ideaMazeHome, 'data'), { recursive: true });
    process.env.IDEA_MAZE_HOME = ideaMazeHome;
    vi.resetModules();
    mocks.generateExplorationJson.mockReset();
  });

  afterEach(async () => {
    const { closeDb } = await import('./db.ts');
    closeDb();
    delete process.env.IDEA_MAZE_HOME;
    fs.rmSync(ideaMazeHome, { recursive: true, force: true });
  });

  it('refuses non-approved opportunities by default', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { prepareExploration } = await import('./exploration.ts');
    const db = getDb();
    initSchema(db);
    await insertOpportunity(db, { slug: 'raw-idea', lifecycle_stage: 'review_gate' });
    await expect(prepareExploration('raw-idea', { db, logger: quietLogger() })).rejects.toThrow('requires approved active opportunity');
  });

  it('prepares prompt context for approved active opportunities', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { prepareExploration } = await import('./exploration.ts');
    const db = getDb();
    initSchema(db);
    await insertOpportunity(db);
    const result = await prepareExploration('voice-looking', { db, logger: quietLogger() });
    expect(result.status).toBe('awaiting_external_brief');
    expect(result.prompt).toContain('voice-looking');
  });

  it('persists default engine exploration briefs without changing approval state', async () => {
    mocks.generateExplorationJson.mockResolvedValue(brief);
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { exploreOpportunity } = await import('./exploration.ts');
    const db = getDb();
    initSchema(db);
    await insertOpportunity(db);
    const result = await exploreOpportunity('voice-looking', { db, logger: quietLogger() });
    expect(result.status).toBe('completed');
    expect(result.briefPath).toContain('/data/explorations/');
    expect(fs.existsSync(result.briefPath!)).toBe(true);
    const opp = db.prepare('SELECT lifecycle_stage, status FROM opportunities WHERE slug=?').get('voice-looking') as any;
    expect(opp).toMatchObject({ lifecycle_stage: 'approved', status: 'active' });
    const counts = db.prepare('SELECT (SELECT COUNT(*) FROM artifacts) artifact_count, (SELECT COUNT(*) FROM exploration_artifacts) exploration_count').get() as any;
    expect(counts).toEqual({ artifact_count: 0, exploration_count: 1 });
  });

  it('returns needs_manual_exploration when external brief validation fails', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { finalizeExploration, prepareExploration } = await import('./exploration.ts');
    const db = getDb();
    initSchema(db);
    await insertOpportunity(db);
    const prepared = await prepareExploration('voice-looking', { db, logger: quietLogger() });
    const result = await finalizeExploration(prepared.runId, {
      db,
      brief: { thesis: 'too thin' },
      logger: quietLogger(),
      providerMetadata: { orchestrator: 'hermes', model: 'gpt-5.5', provider: 'openai-codex' },
    });
    expect(result.status).toBe('needs_manual_exploration');
    const run = db.prepare('SELECT status, metadata_json FROM runs WHERE id=?').get(result.runId) as any;
    expect(run.status).toBe('needs_manual_exploration');
    expect(JSON.parse(run.metadata_json).prompt_metadata.validation_status).toBe('invalid_external_brief');
  });
});
