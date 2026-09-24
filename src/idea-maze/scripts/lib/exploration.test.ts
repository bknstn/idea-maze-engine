import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEvidenceExcerpt } from './evidence-excerpts.ts';
import type { ValidatedExplorationBrief } from './validation.ts';

const mocks = vi.hoisted(() => ({
  generateExplorationJson: vi.fn(),
}));

vi.mock('./llm.ts', () => ({
  generateExplorationJson: mocks.generateExplorationJson,
  getExplorationModel: () => 'gpt-5.6-sol',
  getMissingLlmReason: () => 'LLM provider "openai" is not configured',
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

function insertSourceEvidence(
  db: any,
  opportunitySlug: string,
  input: { text: string; excerptText?: string; excerpts: Array<{ role: 'pain' | 'workaround' | 'wtp' | 'time_loss'; quote: string }> },
): number {
  const now = '2026-09-24T00:00:00.000Z';
  const sourceItemId = Number(db.prepare(`
    INSERT INTO source_items (source,external_id,title,text,canonical_url,channel_or_label,timestamp_utc,ingested_at_utc,raw_path,content_hash,metadata_json)
    VALUES ('reddit',?,'Evidence post',?,'https://reddit.example/post/1','founders',?,?, '/tmp/source.json','ingest-hash','{}')
  `).run(`post-${input.text.length}-${input.excerpts.length}`, input.text, now, now).lastInsertRowid);
  db.prepare(`
    INSERT INTO opportunity_sources (opportunity_id,source_item_id)
    SELECT id, ? FROM opportunities WHERE slug = ?
  `).run(sourceItemId, opportunitySlug);
  const excerpts = input.excerpts.map(({ role, quote }) => createEvidenceExcerpt({
    sourceItemId,
    role,
    sourceText: input.excerptText ?? input.text,
    candidate: quote,
  })!);
  db.prepare(`
    INSERT INTO insights (source_item_id,insight_type,summary,evidence_score,confidence,status,metadata_json,created_at_utc)
    VALUES (?,'pain_point','Direct evidence',0.9,0.9,'new',?,?)
  `).run(sourceItemId, JSON.stringify({
    evidence_excerpt_version: 1,
    evidence_excerpt_coverage: 'complete',
    evidence_excerpt_candidate_count: excerpts.length,
    evidence_excerpt_rejected_count: 0,
    evidence_excerpts: excerpts,
  }), now);
  return sourceItemId;
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

  it('puts tail excerpts in the exploration packet and never labels stale excerpts verified', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { prepareExploration } = await import('./exploration.ts');
    const db = getDb();
    initSchema(db);
    await insertOpportunity(db);

    const pain = 'At the end of the post, I lose two hours every Friday.';
    const workaround = 'At the end, I copy every invoice into a spreadsheet.';
    const wtp = 'At the end, I would pay for a reliable fix.';
    const timeLoss = 'At the end, this costs our team three hours.';
    const tail = `${pain} ${workaround} ${wtp} ${timeLoss}`;
    insertSourceEvidence(db, 'voice-looking', {
      text: `Beginning of a long post. ${'Unrelated background paragraph. '.repeat(250)}${tail}`,
      excerpts: [
        { role: 'pain', quote: pain },
        { role: 'workaround', quote: workaround },
        { role: 'wtp', quote: wtp },
        { role: 'time_loss', quote: timeLoss },
      ],
    });
    insertSourceEvidence(db, 'voice-looking', {
      text: 'The edited source has no old sentence anymore.',
      excerptText: 'Old source said: VERIFIED_STALE_SNIPPET should not survive.',
      excerpts: [{ role: 'pain', quote: 'VERIFIED_STALE_SNIPPET' }],
    });

    const result = await prepareExploration('voice-looking', { db, logger: quietLogger() });
    expect(result.prompt).toContain(`⟦${pain}⟧`);
    expect(result.prompt).toContain(`⟦${workaround}⟧`);
    expect(result.prompt).toContain(`⟦${wtp}⟧`);
    expect(result.prompt).toContain(`⟦${timeLoss}⟧`);
    expect(result.prompt).toContain('Stored excerpt failed source-text revalidation');
    expect(result.prompt).not.toContain('⟦VERIFIED_STALE_SNIPPET⟧');
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
      providerMetadata: { orchestrator: 'hermes', model: 'gpt-5.6-sol', provider: 'openai-codex' },
    });
    expect(result.status).toBe('needs_manual_exploration');
    const run = db.prepare('SELECT status, metadata_json FROM runs WHERE id=?').get(result.runId) as any;
    expect(run.status).toBe('needs_manual_exploration');
    expect(JSON.parse(run.metadata_json).prompt_metadata.validation_status).toBe('invalid_external_brief');
  });
});
