import { describe, expect, it } from 'vitest';

import {
  evaluateEvidenceQuality,
  type EvidenceSourceSummary,
} from './evidence-quality.ts';

function source(input: Partial<EvidenceSourceSummary> & { id: number; text: string }): EvidenceSourceSummary {
  return {
    canonical_url: null,
    channel_or_label: null,
    content_hash: null,
    metadata_json: null,
    source: 'reddit',
    title: null,
    ...input,
  };
}

describe('evaluateEvidenceQuality', () => {
  it('allows three independent direct-pain sources into review eligibility', () => {
    const result = evaluateEvidenceQuality(
      [
        source({ id: 1, text: 'I am frustrated that invoice reconciliation takes hours every Friday.' }),
        source({ id: 2, text: 'Manual matching is painful and wastes time for my finance team.' }),
        source({ id: 3, text: 'We lose half a day every month fixing payment mismatches.' }),
      ],
      { finalScore: 9.4, validationStatus: 'valid' },
    );

    expect(result.disposition).toBe('review_eligible');
    expect(result.independentSourceCount).toBe(3);
    expect(result.adjustedMaxScore).toBe(10);
    expect(result.reasons).not.toContain('insufficient_independent_sources');
  });

  it('caps copied source evidence and marks it as needing more evidence', () => {
    const copiedText = 'Manual reconciliation is painful and takes hours every week.';
    const result = evaluateEvidenceQuality(
      [
        source({ id: 1, text: copiedText, content_hash: 'same' }),
        source({ id: 2, text: copiedText, content_hash: 'same' }),
        source({ id: 3, text: copiedText, content_hash: 'same' }),
      ],
      { finalScore: 9.8, validationStatus: 'valid' },
    );

    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.independentSourceCount).toBe(1);
    expect(result.sourceQuality.duplicateContentCount).toBe(2);
    expect(result.adjustedMaxScore).toBe(7);
    expect(result.reasons).toContain('duplicate_sources');
    expect(result.reasons).toContain('insufficient_independent_sources');
  });

  it('quarantines fallback-template drafts regardless of score', () => {
    const result = evaluateEvidenceQuality(
      [
        source({ id: 1, text: 'This is painful and takes hours.' }),
        source({ id: 2, text: 'I would pay for a fix because this wastes time.' }),
        source({ id: 3, text: 'My team keeps struggling with this workflow.' }),
      ],
      { finalScore: 10, validationStatus: 'fallback_template' },
    );

    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.adjustedMaxScore).toBe(0);
    expect(result.reasons).toContain('fallback_template');
  });

  it('caps launch-brag and self-promo dominated sources', () => {
    const result = evaluateEvidenceQuality(
      [
        source({ id: 1, text: 'I launched my SaaS and we are on Product Hunt today.' }),
        source({ id: 2, text: 'I built an AI wrapper and want feedback on pricing.' }),
        source({ id: 3, text: 'Check out my new app launch for founders.' }),
      ],
      { finalScore: 9.2, validationStatus: 'valid' },
    );

    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.sourceQuality.promoCount).toBe(3);
    expect(result.adjustedMaxScore).toBe(6);
    expect(result.reasons).toContain('promo_dominated');
  });

  it('blocks high scores with no direct buyer pain, WTP, or time-loss evidence', () => {
    const result = evaluateEvidenceQuality(
      [
        source({ id: 1, text: 'Here is a generic overview of productivity tools.' }),
        source({ id: 2, text: 'The category has many apps and integrations.' }),
        source({ id: 3, text: 'People discuss this topic often online.' }),
      ],
      { finalScore: 9.6, validationStatus: 'valid' },
    );

    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.adjustedMaxScore).toBe(7);
    expect(result.reasons).toContain('no_direct_buyer_pain');
  });
});
