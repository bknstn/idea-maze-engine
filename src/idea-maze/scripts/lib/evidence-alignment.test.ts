import { describe, expect, it } from 'vitest';
import { evaluateEvidenceAlignment, type EvidenceAlignmentCard } from './evidence-alignment.ts';
import type { EvidenceSourceSummary } from './evidence-quality.ts';

const sources: EvidenceSourceSummary[] = [
  { id: 1, source: 'reddit', title: null, text: 'I spend three hours matching supplier payments, but the receipt is already clean enough.', canonical_url: null, channel_or_label: null },
  { id: 2, source: 'reddit', title: null, text: 'I hate chasing missing client documents every Friday.', canonical_url: null, channel_or_label: null },
  { id: 3, source: 'reddit', title: null, text: 'I built the exact client document product; join my waitlist.', canonical_url: null, channel_or_label: null },
];
function card(input: Partial<EvidenceAlignmentCard> & { source_id: number }): EvidenceAlignmentCard {
  return { source_id: input.source_id, relation: 'irrelevant', buyer_present: false, pain_quote: null, wtp_quote: null, time_loss_quote: null, workaround_quote: null, reason: 'not relevant', contradiction_resolved: false, ...input };
}

describe('evaluateEvidenceAlignment', () => {
  it('blocks a grounded contradiction', () => {
    const result = evaluateEvidenceAlignment(sources, [card({ source_id: 1, relation: 'contradicts', buyer_present: true, pain_quote: 'the receipt is already clean enough', reason: 'existing output is sufficient' })]);
    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.reasons).toContain('contradicting_primary_source');
    expect(result.contradictCount).toBe(1);
  });
  it('grounds contradictions through non-pain quote fields', () => {
    const result = evaluateEvidenceAlignment(sources, [
      card({
        source_id: 1,
        relation: 'contradicts',
        buyer_present: true,
        pain_quote: null,
        workaround_quote: 'the receipt is already clean enough',
        reason: 'the current output is sufficient',
      }),
    ]);
    expect(result.contradictCount).toBe(1);
    expect(result.reasons).toContain('contradicting_primary_source');
  });
  it('still blocks an unresolved contradiction when three sources support the thesis', () => {
    const expanded = [
      ...sources,
      { id: 4, source: 'reddit', title: null, text: 'Our team wastes hours collecting client documents.', canonical_url: null, channel_or_label: null },
      { id: 5, source: 'reddit', title: null, text: 'I manually chase client receipts each week.', canonical_url: null, channel_or_label: null },
    ];
    const result = evaluateEvidenceAlignment(expanded, [
      card({ source_id: 1, relation: 'contradicts', buyer_present: true, pain_quote: 'the receipt is already clean enough', reason: 'existing output is sufficient' }),
      card({ source_id: 2, relation: 'supports', buyer_present: true, pain_quote: 'I hate chasing missing client documents every Friday.', reason: 'direct pain' }),
      card({ source_id: 4, relation: 'supports', buyer_present: true, pain_quote: 'Our team wastes hours collecting client documents.', reason: 'direct pain' }),
      card({ source_id: 5, relation: 'supports', buyer_present: true, pain_quote: 'I manually chase client receipts each week.', reason: 'direct pain' }),
    ]);
    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.reasons).toContain('contradicting_primary_source');
  });
  it('does not treat crossposted supports as three independent sources', () => {
    const repeatedText = 'I hate chasing missing client documents every Friday.';
    const expanded: EvidenceSourceSummary[] = [
      sources[0],
      ...[2, 4, 5].map((id) => ({ id, source: 'reddit', title: null, text: repeatedText, canonical_url: null, channel_or_label: null, content_hash: `crosspost-${id}` })),
    ];
    const result = evaluateEvidenceAlignment(expanded, [
      card({ source_id: 1, relation: 'contradicts', buyer_present: true, pain_quote: null, workaround_quote: 'the receipt is already clean enough', contradiction_resolved: true, reason: 'resolved contradiction' }),
      ...[2, 4, 5].map((source_id) => card({ source_id, relation: 'supports', buyer_present: true, pain_quote: repeatedText, reason: 'direct pain' })),
    ]);
    expect(result.alignedBuyerSourceCount).toBe(1);
    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.reasons).toContain('contradicting_primary_source');
  });
  it('does not count search or Tavily cards as buyer support', () => {
    const searchSources: EvidenceSourceSummary[] = [
      { id: 10, source: 'search', title: null, text: 'I hate chasing client documents.', canonical_url: null, channel_or_label: 'tavily' },
    ];
    const result = evaluateEvidenceAlignment(searchSources, [
      card({ source_id: 10, relation: 'supports', buyer_present: true, pain_quote: 'I hate chasing client documents.', reason: 'search context' }),
    ]);
    expect(result.alignedBuyerSourceCount).toBe(0);
  });
  it('does not count generic unrelated pain', () => {
    const result = evaluateEvidenceAlignment(sources, [card({ source_id: 1, relation: 'irrelevant', buyer_present: true, pain_quote: 'I spend three hours', reason: 'different supplier-payment thesis' })]);
    expect(result.alignedBuyerSourceCount).toBe(0);
    expect(result.irrelevantCount).toBe(1);
  });
  it('does not count promo describing the exact product', () => {
    const result = evaluateEvidenceAlignment(sources, [card({ source_id: 3, relation: 'promo', buyer_present: false, pain_quote: null, reason: 'founder promotion' })]);
    expect(result.alignedBuyerSourceCount).toBe(0);
    expect(result.promoCount).toBe(1);
  });
  it('does not trust a model that labels promotional content as support', () => {
    const result = evaluateEvidenceAlignment(sources, [card({
      source_id: 3,
      relation: 'supports',
      buyer_present: true,
      pain_quote: 'I built the exact client document product',
      reason: 'claimed support',
    })]);
    expect(result.alignedBuyerSourceCount).toBe(0);
    expect(result.promoCount).toBe(1);
  });
  it('fails conservatively on malformed boolean fields', () => {
    const malformed = card({ source_id: 2, relation: 'supports', buyer_present: true, pain_quote: 'I hate chasing missing client documents every Friday.', reason: 'direct pain' });
    (malformed as unknown as { buyer_present: unknown }).buyer_present = 'false';
    const result = evaluateEvidenceAlignment(sources, [malformed]);
    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.reasons).toContain('invalid_alignment_quotes');
    expect(result.alignedBuyerSourceCount).toBe(0);
  });
  it('counts a valid exact direct buyer quote', () => {
    const result = evaluateEvidenceAlignment(sources, [card({ source_id: 2, relation: 'supports', buyer_present: true, pain_quote: 'I hate chasing missing client documents every Friday.', reason: 'direct buyer pain' })]);
    expect(result.alignedBuyerSourceCount).toBe(1);
    expect(result.cards[0].grounded).toBe(true);
  });
  it('rejects a fabricated quote', () => {
    const result = evaluateEvidenceAlignment(sources, [card({ source_id: 2, relation: 'supports', buyer_present: true, pain_quote: 'I would pay $100 a month', reason: 'claimed WTP' })]);
    expect(result.alignedBuyerSourceCount).toBe(0);
    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.reasons).toContain('invalid_alignment_quotes');
  });
  it('fails conservatively when alignment is unavailable', () => {
    const result = evaluateEvidenceAlignment(sources, null);
    expect(result.disposition).toBe('needs_more_evidence');
    expect(result.reasons).toContain('alignment_unavailable');
  });
});
