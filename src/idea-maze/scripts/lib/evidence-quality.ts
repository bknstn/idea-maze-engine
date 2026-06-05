export type EvidenceGateDisposition =
  | 'review_eligible'
  | 'needs_more_evidence'
  | 'auto_reject';

export interface EvidenceSourceSummary {
  id: number;
  source: string;
  title: string | null;
  text: string;
  canonical_url: string | null;
  channel_or_label: string | null;
  content_hash?: string | null;
  metadata_json?: string | null;
}

export interface EvidenceQualityResult {
  adjustedMaxScore: number;
  disposition: EvidenceGateDisposition;
  independentSourceCount: number;
  reasons: string[];
  sourceQuality: {
    directPainCount: number;
    duplicateContentCount: number;
    promoCount: number;
    wtpOrBudgetCount: number;
    timeLossCount: number;
  };
}

const DIRECT_PAIN_PATTERNS = [
  /\b(pain|painful|frustrat(?:ed|ing)|struggl(?:e|ing)|annoy(?:ed|ing)|hard|difficult|problem|broken|manual|tedious|hate|blocked|confusing)\b/i,
  /\b(keep|keeps|cannot|can't|waste|wastes|los(?:e|ing))\b.*\b(time|hours?|days?|weekends?)\b/i,
];

const WTP_OR_BUDGET_PATTERNS = [
  /\b(would pay|pay for|paid|budget|pricing|subscription|invoice|purchase|buy|costs? us|expensive)\b/i,
];

const TIME_LOSS_PATTERNS = [
  /\b(takes?|wastes?|los(?:e|ing)|spend|spent|burns?)\b.{0,40}\b(minutes?|hours?|days?|weeks?|half a day|weekend)\b/i,
  /\b(minutes?|hours?|days?|weeks?)\b.{0,40}\b(each|every|per|weekly|monthly|daily)\b/i,
];

const PROMO_PATTERNS = [
  /\b(i|we)\s+(built|launched|made|created|shipped)\b/i,
  /\b(product hunt|launch(?:ed|ing)?|check out my|try my|my saas|our saas|waitlist|feedback on (?:my|our)|show hn)\b/i,
  /\b(ai wrapper|new app|new tool)\b/i,
];

function normalizeForFingerprint(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function sourceFingerprint(source: EvidenceSourceSummary): string {
  if (source.content_hash?.trim()) {
    return `hash:${source.content_hash.trim()}`;
  }
  const normalized = normalizeForFingerprint(`${source.title ?? ''} ${source.text}`);
  return `text:${normalized.slice(0, 240)}`;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function capScore(current: number, cap: number): number {
  return Math.min(current, cap);
}

export function evaluateEvidenceQuality(
  sources: EvidenceSourceSummary[],
  options: { finalScore: number; validationStatus?: string | null },
): EvidenceQualityResult {
  const reasons = new Set<string>();
  let adjustedMaxScore = 10;
  let disposition: EvidenceGateDisposition = 'review_eligible';
  const fingerprints = new Set<string>();
  let duplicateContentCount = 0;
  let directPainCount = 0;
  let promoCount = 0;
  let wtpOrBudgetCount = 0;
  let timeLossCount = 0;

  for (const source of sources) {
    const fingerprint = sourceFingerprint(source);
    if (fingerprints.has(fingerprint)) {
      duplicateContentCount++;
    } else {
      fingerprints.add(fingerprint);
    }

    const text = `${source.title ?? ''}\n${source.text}`;
    if (matchesAny(text, DIRECT_PAIN_PATTERNS)) directPainCount++;
    if (matchesAny(text, WTP_OR_BUDGET_PATTERNS)) wtpOrBudgetCount++;
    if (matchesAny(text, TIME_LOSS_PATTERNS)) timeLossCount++;
    if (matchesAny(text, PROMO_PATTERNS)) promoCount++;
  }

  if (options.validationStatus === 'fallback_template') {
    reasons.add('fallback_template');
    adjustedMaxScore = 0;
    disposition = 'needs_more_evidence';
  }

  const independentSourceCount = fingerprints.size;
  if (duplicateContentCount > 0) {
    reasons.add('duplicate_sources');
  }
  if (independentSourceCount < 3) {
    reasons.add('insufficient_independent_sources');
    adjustedMaxScore = capScore(adjustedMaxScore, 7);
    disposition = 'needs_more_evidence';
  }

  if (promoCount > 0) {
    reasons.add('promo_sources');
  }
  if (sources.length > 0 && promoCount / sources.length >= 0.5) {
    reasons.add('promo_dominated');
    adjustedMaxScore = capScore(adjustedMaxScore, 6);
    disposition = 'needs_more_evidence';
  }

  if (directPainCount === 0 && wtpOrBudgetCount === 0 && timeLossCount === 0) {
    reasons.add('no_direct_buyer_pain');
    adjustedMaxScore = capScore(adjustedMaxScore, 7);
    disposition = 'needs_more_evidence';
  }

  if (options.finalScore > adjustedMaxScore && disposition === 'review_eligible') {
    disposition = 'needs_more_evidence';
  }

  return {
    adjustedMaxScore,
    disposition,
    independentSourceCount,
    reasons: [...reasons],
    sourceQuality: {
      directPainCount,
      duplicateContentCount,
      promoCount,
      wtpOrBudgetCount,
      timeLossCount,
    },
  };
}
