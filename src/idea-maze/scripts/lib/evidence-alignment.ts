import { generateEvidenceAlignmentJson } from './llm.ts';
import { buildEvidenceAlignmentUserPrompt, EVIDENCE_ALIGNMENT_SYSTEM_PROMPT } from './prompts.ts';
import {
  isPromotionalEvidenceSource,
  normalizeEvidenceText,
  type EvidenceGateDisposition,
  type EvidenceSourceSummary,
} from './evidence-quality.ts';

export type EvidenceRelation = 'supports' | 'contradicts' | 'context' | 'irrelevant' | 'promo';
export interface EvidenceAlignmentCard {
  source_id: number;
  relation: EvidenceRelation;
  buyer_present: boolean;
  pain_quote: string | null;
  wtp_quote: string | null;
  time_loss_quote: string | null;
  workaround_quote: string | null;
  reason: string;
  contradiction_resolved?: boolean;
}
export interface ValidatedEvidenceAlignmentCard extends EvidenceAlignmentCard {
  grounded: boolean;
  invalid_quotes: string[];
}
export interface EvidenceAlignmentResult {
  adjustedMaxScore: number;
  alignedBuyerSourceCount: number;
  cards: ValidatedEvidenceAlignmentCard[];
  contradictCount: number;
  disposition: EvidenceGateDisposition;
  irrelevantCount: number;
  promoCount: number;
  reasons: string[];
}

const RELATIONS = new Set<EvidenceRelation>(['supports', 'contradicts', 'context', 'irrelevant', 'promo']);
const QUOTE_FIELDS = ['pain_quote', 'wtp_quote', 'time_loss_quote', 'workaround_quote'] as const;

function isPrimaryBuyerSource(source: EvidenceSourceSummary | undefined): boolean {
  if (!source) return false;
  const identity = `${source.source} ${source.channel_or_label ?? ''}`.toLowerCase();
  return !identity.includes('search') && !identity.includes('tavily');
}

export function evaluateEvidenceAlignment(sources: EvidenceSourceSummary[], cards: EvidenceAlignmentCard[] | null): EvidenceAlignmentResult {
  const reasons = new Set<string>();
  if (!cards) return { adjustedMaxScore: 7, alignedBuyerSourceCount: 0, cards: [], contradictCount: 0, disposition: 'needs_more_evidence', irrelevantCount: 0, promoCount: 0, reasons: ['alignment_unavailable'] };
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const seen = new Set<number>();
  const validated: ValidatedEvidenceAlignmentCard[] = [];
  let invalid = false;
  for (const raw of cards) {
    const source = sourceMap.get(Number(raw.source_id));
    if (
      !source ||
      seen.has(Number(raw.source_id)) ||
      !RELATIONS.has(raw.relation) ||
      typeof raw.buyer_present !== 'boolean' ||
      typeof raw.contradiction_resolved !== 'boolean'
    ) {
      invalid = true;
      continue;
    }
    seen.add(Number(raw.source_id));
    const haystack = normalizeEvidenceText(`${source.title ?? ''} ${source.text}`);
    const invalidQuotes = QUOTE_FIELDS.filter((field) => {
      const quote = raw[field];
      return quote !== null && (typeof quote !== 'string' || !quote.trim() || !haystack.includes(normalizeEvidenceText(quote)));
    });
    if (invalidQuotes.length) invalid = true;
    const painGrounded = typeof raw.pain_quote === 'string' && raw.pain_quote.trim().length > 0 && !invalidQuotes.includes('pain_quote');
    const anyQuoteGrounded = QUOTE_FIELDS.some((field) => {
      const quote = raw[field];
      return typeof quote === 'string' && quote.trim().length > 0 && !invalidQuotes.includes(field);
    });
    const grounded = invalidQuotes.length === 0 && (
      raw.relation === 'supports' ? painGrounded : anyQuoteGrounded
    );
    validated.push({ ...raw, grounded, invalid_quotes: invalidQuotes });
  }
  if (invalid) reasons.add('invalid_alignment_quotes');
  const supportHashes = new Set<string>();
  const supportSignatures = new Set<string>();
  const supports = validated.filter((card) => {
    const source = sourceMap.get(card.source_id);
    if (
      card.relation !== 'supports' ||
      !card.buyer_present ||
      !card.grounded ||
      !isPrimaryBuyerSource(source) ||
      !source ||
      isPromotionalEvidenceSource(source)
    ) {
      return false;
    }
    const hash = source.content_hash?.trim() || null;
    const signature = normalizeEvidenceText(`${source.title ?? ''} ${source.text}`).slice(0, 500);
    if ((hash && supportHashes.has(hash)) || supportSignatures.has(signature)) return false;
    if (hash) supportHashes.add(hash);
    supportSignatures.add(signature);
    return true;
  });
  const contradictions = validated.filter((card) =>
    card.relation === 'contradicts' &&
    card.grounded &&
    isPrimaryBuyerSource(sourceMap.get(card.source_id)),
  );
  const unresolved = contradictions.filter((card) => !card.contradiction_resolved);
  if (contradictions.length > 0 && (unresolved.length > 0 || supports.length < 3)) {
    reasons.add('contradicting_primary_source');
  }
  if (supports.length < 2) reasons.add('insufficient_aligned_buyer_sources');
  const disposition: EvidenceGateDisposition = reasons.size ? 'needs_more_evidence' : 'review_eligible';
  return {
    adjustedMaxScore: disposition === 'review_eligible' ? 10 : 7,
    alignedBuyerSourceCount: supports.length,
    cards: validated,
    contradictCount: contradictions.length,
    disposition,
    irrelevantCount: validated.filter((card) => card.relation === 'irrelevant').length,
    promoCount: validated.filter((card) => {
      const source = sourceMap.get(card.source_id);
      return card.relation === 'promo' || (source ? isPromotionalEvidenceSource(source) : false);
    }).length,
    reasons: [...reasons],
  };
}

export async function alignOpportunityEvidence(input: { title: string; thesis: string; sources: EvidenceSourceSummary[] }): Promise<EvidenceAlignmentResult> {
  if (input.sources.length === 0) return evaluateEvidenceAlignment(input.sources, null);
  try {
    const response = await generateEvidenceAlignmentJson<{ cards: EvidenceAlignmentCard[] }>(
      EVIDENCE_ALIGNMENT_SYSTEM_PROMPT,
      buildEvidenceAlignmentUserPrompt(input),
    );
    if (!response || !Array.isArray(response.cards) || response.cards.length !== input.sources.length) {
      return evaluateEvidenceAlignment(input.sources, null);
    }
    return evaluateEvidenceAlignment(input.sources, response.cards);
  } catch {
    return evaluateEvidenceAlignment(input.sources, null);
  }
}
