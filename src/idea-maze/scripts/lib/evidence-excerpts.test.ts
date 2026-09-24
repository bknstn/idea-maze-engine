import { describe, expect, it } from 'vitest';

import {
  createEvidenceExcerpt,
  hashSourceText,
  recoverEvidenceQuote,
  sampleSourceText,
  verifyEvidenceExcerpt,
} from './evidence-excerpts.ts';

describe('evidence excerpt grounding', () => {
  it('stores the exact source substring with UTF-16 offsets and a text-only hash', () => {
    const sourceText = 'The operator said: “Manual reconciliation wastes three hours every Friday.”';
    const quote = 'Manual reconciliation wastes three hours every Friday.';
    const excerpt = createEvidenceExcerpt({
      sourceItemId: 42,
      role: 'pain',
      sourceText,
      candidate: quote,
    });

    expect(excerpt).toEqual({
      version: 1,
      sourceItemId: 42,
      role: 'pain',
      quote,
      sourceTextHash: hashSourceText(sourceText),
      startUtf16: sourceText.indexOf(quote),
      endUtf16: sourceText.indexOf(quote) + quote.length,
    });
    expect(sourceText.slice(excerpt!.startUtf16, excerpt!.endUtf16)).toBe(quote);
    // Reddit's ingestion content_hash includes the title; excerpt identity does not.
    const sourceTextHashBeforeTitleChange = hashSourceText(sourceText);
    const sourceTextHashAfterTitleChange = hashSourceText(sourceText);
    expect(sourceTextHashBeforeTitleChange).toBe(sourceTextHashAfterTitleChange);
    expect(hashSourceText(`old title\n${sourceText}`)).not.toBe(hashSourceText(`new title\n${sourceText}`));
  });

  it('recovers Unicode quotes and rejects empty-normalized or fabricated text', () => {
    const sourceText = 'Я бухгалтер: вручную свожу счета каждую пятницу — это тяжело.';
    const recovered = recoverEvidenceQuote(sourceText, 'БУХГАЛТЕР: вручную свожу счета');
    expect(recovered?.quote).toBe('бухгалтер: вручную свожу счета');
    expect(recoverEvidenceQuote(sourceText, 'привет бухгалтер')).toBeNull();
    expect(recoverEvidenceQuote(sourceText, '   — <br> &nbsp;')).toBeNull();
    expect(recoverEvidenceQuote('C# tooling is painful', 'C++')).toBeNull();
    expect(recoverEvidenceQuote('We use C# every day', 'We use C++ every day')).toBeNull();
    expect(recoverEvidenceQuote('The price is 1.50 per user', 'The price is 1,50 per user')).toBeNull();
    expect(recoverEvidenceQuote('Price 1.50\nper user', 'Price 1.50 per user')?.quote).toBe('Price 1.50\nper user');
  });

  it('matches canonical Unicode while returning the original decomposed substring', () => {
    const sourceText = 'Cafe\u0301 users lose time.';
    const recovered = recoverEvidenceQuote(sourceText, 'Café users lose time.');
    expect(recovered?.quote).toBe(sourceText);
    expect(sourceText.slice(recovered!.startUtf16, recovered!.endUtf16)).toBe(sourceText);
  });

  it('maps normalized HTML entities back to the original HTML source substring', () => {
    const sourceText = '<p>Я &amp; ты теряем время на счетах.</p>';
    const recovered = recoverEvidenceQuote(sourceText, 'Я & ты теряем время');
    expect(recovered).not.toBeNull();
    expect(recovered!.quote).toBe('Я &amp; ты теряем время');
    expect(sourceText.slice(recovered!.startUtf16, recovered!.endUtf16)).toBe(recovered!.quote);
  });

  it('preserves comparison text that only resembles HTML markup', () => {
    const sourceText = 'The batch fails when cost < 5 and hours > 2.';
    expect(recoverEvidenceQuote(sourceText, 'cost < 5 and hours > 2')?.quote)
      .toBe('cost < 5 and hours > 2');
  });

  it('rechecks stored excerpts against the current source text and hash', () => {
    const sourceText = 'We copy payment details into a spreadsheet every morning.';
    const excerpt = createEvidenceExcerpt({
      sourceItemId: 7,
      role: 'workaround',
      sourceText,
      candidate: 'copy payment details into a spreadsheet',
    })!;

    expect(verifyEvidenceExcerpt({ sourceItemId: 7, sourceText, excerpt })).toEqual(excerpt);
    expect(verifyEvidenceExcerpt({ sourceItemId: 7, sourceText: `${sourceText} changed`, excerpt })).toBeNull();
    expect(verifyEvidenceExcerpt({ sourceItemId: 8, sourceText, excerpt })).toBeNull();
    expect(verifyEvidenceExcerpt({
      sourceItemId: 7,
      sourceText,
      excerpt: { ...excerpt, startUtf16: 0, endUtf16: excerpt.quote.length },
    })).toBeNull();
  });

  it('only grounds quotes inside the windows shown to the model', () => {
    const sourceText = `Beginning pain. ${'filler '.repeat(20)} MIDDLE_UNIQUE_ACTOR phrase. ${'context '.repeat(20)} Tail users lose hours every Friday.`;
    const sample = sampleSourceText(sourceText, 90);
    expect(sample.complete).toBe(false);
    expect(sample.formatted).toContain('partial source sample');
    expect(sample.formatted).toContain('omitted source text');
    expect(sample.windows.at(-1)?.text).toContain('users lose hours every Friday.');
    expect(createEvidenceExcerpt({
      sourceItemId: 2,
      role: 'time_loss',
      sourceText,
      candidate: 'users lose hours every Friday.',
      visibleRanges: sample.windows,
    })?.quote).toBe('users lose hours every Friday.');
    expect(createEvidenceExcerpt({
      sourceItemId: 2,
      role: 'pain',
      sourceText,
      candidate: 'MIDDLE_UNIQUE_ACTOR phrase',
      visibleRanges: sample.windows,
    })).toBeNull();
  });

  it('keeps surrogate pairs intact and reports complete short sources', () => {
    const text = `😀 ${'context '.repeat(10)} tail quote`;
    const sample = sampleSourceText(text, 20);
    for (const window of sample.windows) {
      const before = text.charCodeAt(window.startUtf16 - 1);
      const first = text.charCodeAt(window.startUtf16);
      expect(!(before >= 0xd800 && before <= 0xdbff && first >= 0xdc00 && first <= 0xdfff)).toBe(true);
      expect(window.text).toBe(text.slice(window.startUtf16, window.endUtf16));
    }
    expect(() => sampleSourceText('😀 test', 1)).toThrow('at least 3 UTF-16 code units');
    const short = sampleSourceText('short source', 100);
    expect(short.complete).toBe(true);
    expect(short.windows).toEqual([{ startUtf16: 0, endUtf16: 12, text: 'short source' }]);
  });
});
