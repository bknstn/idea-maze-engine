import { describe, expect, it } from 'vitest';
import {
  buildEvidenceAlignmentUserPrompt,
  buildHarvestUserPrompt,
  EXPLORATION_PROMPT_NAME,
  EXPLORATION_PROMPT_VERSION,
  buildExplorationUserPrompt,
} from './prompts.ts';

describe('exploration prompt', () => {
  it('includes approved opportunity context and required JSON fields', () => {
    const prompt = buildExplorationUserPrompt({
      slug: 'voice-looking',
      title: 'Voice Looking',
      thesis: 'Managers lose delegated tasks.',
      approved_research_draft: 'Voice-first delegation draft.',
      source_evidence: ['reddit: direct buyer asks for voice delegation'],
      contextual_research: ['Todoist is broad task management'],
      search_synthesis: ['Competitors are broad PM tools'],
    });
    expect(EXPLORATION_PROMPT_NAME).toBe('idea-maze-exploration');
    expect(EXPLORATION_PROMPT_VERSION).toMatch(/^2026-/);
    expect(prompt).toContain('voice-looking');
    expect(prompt).toContain('approved_research_draft');
    expect(prompt).toContain('competitor_map');
    expect(prompt).toContain('kill_criteria');
    expect(prompt).toContain('Do not count web search as independent buyer-pain evidence');
  });
});

describe('bounded evidence prompts', () => {
  it('shows a quote at the tail of a long source and marks omitted text', () => {
    const tailQuote = 'At the end of this post, users waste three hours every Friday.';
    const text = `Start of source. ${'Unrelated middle detail. '.repeat(300)}${tailQuote}`;
    const alignmentPrompt = buildEvidenceAlignmentUserPrompt({
      title: 'Payments',
      thesis: 'Users need reconciliation help.',
      sources: [{ id: 90, source: 'reddit', title: 'Payments', text }],
    });
    const harvestPrompt = buildHarvestUserPrompt({
      source: 'reddit',
      title: 'Payments',
      text,
      harvest_score: 0.8,
    });
    expect(alignmentPrompt).toContain(tailQuote);
    expect(alignmentPrompt).toContain('partial source sample');
    expect(alignmentPrompt).toContain('omitted source text');
    expect(harvestPrompt).toContain(tailQuote);
    expect(harvestPrompt).toContain('partial source sample');
  });
});
