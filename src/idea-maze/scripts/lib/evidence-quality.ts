export type EvidenceGateDisposition = 'review_eligible' | 'needs_more_evidence' | 'auto_reject';

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
  /** @deprecated use independentBuyerSourceCount */
  independentSourceCount: number;
  independentBuyerSourceCount: number;
  reasons: string[];
  sourceQuality: {
    directPainCount: number;
    duplicateContentCount: number;
    genericAiWrapperCount: number;
    genericSearchRefCount: number;
    primaryBuyerSourceCount: number;
    primaryDirectPainCount: number;
    promoCount: number;
    searchResultCount: number;
    wtpOrBudgetCount: number;
    timeLossCount: number;
    workaroundCount: number;
    uniquePrimarySources: number;
    nonPromoPrimarySources: number;
    directBuyerPainSources: number;
    irrelevantSourceCount: number;
    thesisAlignedBuyerSources: number;
  };
}

export interface EvidenceCard {
  buyerUserSignals: number;
  contaminationFlags: string[];
  currentWorkaroundSignals: number;
  directPainSignals: number;
  independentBuyerSourceCount: number;
  incumbentSearchContextCount: number;
  promoOrFounderValidationSignals: number;
  timeLossSignals: number;
  wtpOrBudgetSignals: number;
}

const PAIN = /\b(painful|frustrat(?:ed|ing)|annoy(?:ed|ing)|difficult|broken|manual(?:ly)?|tedious|hate|blocked|confusing|wast(?:e|es|ing)|los(?:e|es|ing)|spend|spent|chasing)\b/i;
const FIRST_PERSON_OR_OPERATOR = /\b(i|i'm|we|my|our|us|team|bookkeepers?|accountants?|owners?|students?|users?|clients?|customers?|finance|agency|staff|manual(?:ly)?)\b/i;
const CONCRETE_WORKFLOW = /\b(invoice|receipt|document|bookkeep|reconcil|payment|matching|export|email|client|customer|spreadsheet|record|data|review|account|workout|exercise|recovery|support|pipeline|pdf|anki|flashcard|supplier|sales|crm|workflow|process|tracking|collect|chasing|planning)\w*/i;
const WTP_OR_BUDGET = /\b(would pay|pay for|paid|budget|pricing|subscription|costs? us|expensive|switch(?:ing)? from|replacing|evaluating vendors?)\b/i;
const TIME_LOSS = /\b(takes?|wastes?|los(?:e|ing)|spend|spent|burns?)\b.{0,50}\b(minutes?|hours?|days?|weeks?|half a day|weekend)\b|\b(minutes?|hours?|days?|weeks?)\b.{0,50}\b(each|every|per|weekly|monthly|daily|friday)\b/i;
const WORKAROUND = /\b(workaround|hack|spreadsheet|google sheets?|notion|airtable|zapier|manual process|copy[-\s]?paste|manually track|currently.{0,50}(using|doing|tracking|managing|handling))\b/i;
const PROMO = /\b(i|we)\s+(built|launched|made|created|shipped)\b|\b(product hunt|launch(?:ed|ing)?|check out my|try my|my saas|our saas|waitlist|feedback on (?:my|our)|show hn|join my)\b|\b(ai wrapper|new app|new tool)\b/i;
const GENERIC_AI_WRAPPER = /\b(ai wrapper|chatgpt wrapper|gpt wrapper|ai (?:assistant|agent|copilot) for (?:everything|anything|productivity|founders?))\b|\b(?:just|basically)\s+(?:an?\s+)?(?:thin\s+)?(?:ai|chatgpt|gpt)\s+wrapper\b/i;
const GENERIC_SEARCH_REF = /\b(self[-\s]?serve|best practices|what is|ultimate guide|complete guide|top \d+|trends?|market size|gartner|forrester|ai tools?|software solutions?|platform overview|category overview)\b/i;
const STOP = new Set(['the','and','for','with','need','needs','automated','automation','better','people','users','tool','assistant','workflow','small','business']);

export function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z0-9#]+;/gi, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function isPromotionalEvidenceSource(source: EvidenceSourceSummary): boolean {
  return PROMO.test(`${source.title ?? ''}\n${source.text}`);
}

function stem(token: string): string {
  return token.replace(/(ing|ers|er|ants|ant|ies|s)$/i, '').slice(0, 9);
}
function thesisTokens(value: string): Set<string> {
  return new Set(normalizeEvidenceText(value).split(' ').filter((x) => x.length >= 4 && !STOP.has(x)).map(stem));
}
function isThesisAligned(text: string, thesis: string): boolean {
  const expected = thesisTokens(thesis);
  if (!expected.size) return true;
  const actual = thesisTokens(text);
  let shared = 0;
  for (const token of expected) if (actual.has(token)) shared++;
  return shared >= Math.min(2, expected.size);
}
function isSearchSource(source: EvidenceSourceSummary): boolean {
  const value = `${source.source} ${source.channel_or_label ?? ''}`.toLowerCase();
  return value.includes('search') || value.includes('tavily');
}
function isDirectPain(text: string): boolean {
  return PAIN.test(text) && FIRST_PERSON_OR_OPERATOR.test(text) && CONCRETE_WORKFLOW.test(text);
}

export function evaluateEvidenceQuality(
  sources: EvidenceSourceSummary[],
  options: { finalScore: number; validationStatus?: string | null; thesis?: string; title?: string },
): EvidenceQualityResult {
  const reasons = new Set<string>();
  let adjustedMaxScore = 10;
  let disposition: EvidenceGateDisposition = 'review_eligible';
  const hashes = new Set<string>();
  const signatures = new Set<string>();
  let duplicateContentCount = 0;
  let directPainCount = 0;
  let genericAiWrapperCount = 0;
  let genericSearchRefCount = 0;
  let promoCount = 0;
  let searchResultCount = 0;
  let wtpOrBudgetCount = 0;
  let timeLossCount = 0;
  let workaroundCount = 0;
  let uniquePrimarySources = 0;
  let nonPromoPrimarySources = 0;
  let directBuyerPainSources = 0;
  let thesisAlignedBuyerSources = 0;
  let richAlignedSources = 0;
  const thesis = `${options.title ?? ''} ${options.thesis ?? ''}`.trim();

  for (const source of sources) {
    const signature = normalizeEvidenceText(`${source.title ?? ''} ${source.text}`).slice(0, 500);
    const hash = source.content_hash?.trim() || null;
    const duplicate = (hash !== null && hashes.has(hash)) || signatures.has(signature);
    if (duplicate) duplicateContentCount++;
    if (hash) hashes.add(hash);
    signatures.add(signature);

    const text = `${source.title ?? ''}\n${source.text}`;
    const search = isSearchSource(source);
    const promo = isPromotionalEvidenceSource(source);
    const pain = isDirectPain(text);
    const aligned = isThesisAligned(text, thesis);
    const wtp = WTP_OR_BUDGET.test(text);
    const time = TIME_LOSS.test(text);
    const workaround = WORKAROUND.test(text);

    if (search) {
      searchResultCount++;
      if (GENERIC_SEARCH_REF.test(text)) genericSearchRefCount++;
    } else if (!duplicate) {
      uniquePrimarySources++;
      if (!promo) nonPromoPrimarySources++;
      if (!promo && pain) directBuyerPainSources++;
      if (!promo && pain && aligned) {
        thesisAlignedBuyerSources++;
        if (wtp || time || workaround) richAlignedSources++;
      }
    }
    if (pain) directPainCount++;
    if (wtp) wtpOrBudgetCount++;
    if (time) timeLossCount++;
    if (workaround) workaroundCount++;
    if (promo) promoCount++;
    if (GENERIC_AI_WRAPPER.test(text)) genericAiWrapperCount++;
  }

  const fail = (reason: string, cap = 7) => {
    reasons.add(reason);
    adjustedMaxScore = Math.min(adjustedMaxScore, cap);
    disposition = 'needs_more_evidence';
  };
  if (options.validationStatus === 'fallback_template') fail('fallback_template', 0);
  if (duplicateContentCount) { reasons.add('duplicate_sources'); reasons.add('crosspost_duplicates'); }
  if (searchResultCount) reasons.add('search_refs_context_only');
  if (genericSearchRefCount) reasons.add('generic_search_refs');
  if (promoCount) reasons.add('promo_sources');
  if (promoCount && nonPromoPrimarySources === 0) fail('promo_only_support', 6);
  if (sources.length && promoCount / sources.length >= 0.5) fail('promo_dominated', 6);
  if (genericAiWrapperCount) fail('generic_ai_wrapper', 6);
  if (directBuyerPainSources === 0) { reasons.add('no_direct_buyer_pain'); fail('weak_direct_pain'); }
  else if (thesisAlignedBuyerSources === 0) fail('irrelevant_sources');
  else if (directBuyerPainSources > thesisAlignedBuyerSources) reasons.add('irrelevant_sources');

  const enough = thesisAlignedBuyerSources >= 3 || (thesisAlignedBuyerSources >= 2 && richAlignedSources > 0);
  if (!enough) fail('insufficient_independent_buyer_sources');
  const richAnywhere = wtpOrBudgetCount > 0 || timeLossCount > 0 || workaroundCount > 0;
  if (richAnywhere && richAlignedSources === 0) reasons.add('rich_signal_not_aligned');
  if (options.finalScore > adjustedMaxScore && disposition === 'review_eligible') disposition = 'needs_more_evidence';

  return {
    adjustedMaxScore,
    disposition,
    independentSourceCount: thesisAlignedBuyerSources,
    independentBuyerSourceCount: thesisAlignedBuyerSources,
    reasons: [...reasons],
    sourceQuality: {
      directPainCount, duplicateContentCount, genericAiWrapperCount, genericSearchRefCount,
      primaryBuyerSourceCount: thesisAlignedBuyerSources,
      primaryDirectPainCount: directBuyerPainSources,
      promoCount, searchResultCount, wtpOrBudgetCount, timeLossCount, workaroundCount,
      uniquePrimarySources,
      nonPromoPrimarySources,
      directBuyerPainSources,
      irrelevantSourceCount: Math.max(0, directBuyerPainSources - thesisAlignedBuyerSources),
      thesisAlignedBuyerSources,
    },
  };
}
