import { describe, expect, it } from 'vitest';

import { buildBatchHarvestUserPrompt } from './prompts.ts';
import { sampleSourceText } from './evidence-excerpts.ts';
import { groundEvidenceExcerpts } from './evidence-extraction.ts';

describe('harvest excerpt extraction contract', () => {
  it('makes the complete tail quote visible and stores only the exact shown substring', () => {
    const quote = 'At the end, we lose two hours reconciling these payments every Friday.';
    const sourceText = `Beginning pain. ${'Old context about unrelated work. '.repeat(180)}${quote}`;
    const sample = sampleSourceText(sourceText, 1500);
    const prompt = buildBatchHarvestUserPrompt([{
      index: 0,
      source: 'reddit',
      title: 'Payment operations',
      text: sourceText,
      harvest_score: 0.9,
    }]);

    expect(sample.complete).toBe(false);
    expect(sample.windows.at(-1)?.text).toContain(quote);
    expect(prompt).toContain(quote);
    expect(prompt).toContain('partial source sample');
    expect(prompt).toContain('omitted source text');

    const grounded = groundEvidenceExcerpts(51, sourceText, [{ role: 'time_loss', quote }], sample.windows);
    expect(grounded).toMatchObject({ candidateCount: 1, rejectedCount: 0 });
    expect(grounded.excerpts).toHaveLength(1);
    expect(grounded.excerpts[0].quote).toBe(quote);
    expect(sourceText.slice(grounded.excerpts[0].startUtf16, grounded.excerpts[0].endUtf16)).toBe(quote);
  });

  it('does not accept a fabricated quote omitted by the visible sample', () => {
    const hiddenQuote = 'MIDDLE_ONLY_CLAIM about a guaranteed budget.';
    const sourceText = `Head of source. ${'filler. '.repeat(180)} ${hiddenQuote} ${'more filler. '.repeat(180)} Tail of source.`;
    const sample = sampleSourceText(sourceText, 1500);
    expect(sample.formatted).not.toContain(hiddenQuote);

    const grounded = groundEvidenceExcerpts(52, sourceText, [{ role: 'wtp', quote: hiddenQuote }], sample.windows);
    expect(grounded.excerpts).toEqual([]);
    expect(grounded.rejectedCount).toBe(1);
  });
});
