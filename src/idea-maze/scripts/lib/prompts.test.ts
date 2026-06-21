import { describe, expect, it } from 'vitest';
import {
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
