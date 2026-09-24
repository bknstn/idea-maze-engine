import { createHash } from 'node:crypto';

import { createEvidenceExcerpt, recoverEvidenceQuote, sampleSourceText, verifyEvidenceExcerpt } from './evidence-excerpts.ts';
import { EVIDENCE_QUOTE_EVAL_FIXTURES, EVIDENCE_QUOTE_EVAL_VERSION, type EvidenceQuoteEvalFixture } from './evidence-quote-eval-fixtures.ts';

const SAMPLE_BUDGET = 1500;

/** Frozen implementation of the 675ef39 ASCII-normalized quote check. */
function baselineNormalize(value: string): string {
  return value.toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function baselineAccepts(fixture: EvidenceQuoteEvalFixture): boolean {
  const quote = fixture.candidateQuote;
  if (quote === null || !quote.trim()) return false;
  return baselineNormalize(`${fixture.sourceTitle ?? ''} ${fixture.sourceText}`)
    .includes(baselineNormalize(quote));
}

function baselinePromptSawQuote(fixture: EvidenceQuoteEvalFixture): boolean {
  return fixture.candidateQuote !== null &&
    recoverEvidenceQuote(fixture.sourceText.slice(0, SAMPLE_BUDGET), fixture.candidateQuote) !== null;
}

function candidatePromptSawQuote(fixture: EvidenceQuoteEvalFixture): boolean {
  if (fixture.candidateQuote === null) return false;
  const sample = sampleSourceText(fixture.sourceText, SAMPLE_BUDGET);
  return sample.windows.some((window) => recoverEvidenceQuote(window.text, fixture.candidateQuote!) !== null);
}

function candidateAccepts(fixture: EvidenceQuoteEvalFixture): boolean {
  if (fixture.candidateQuote === null) return false;
  if (fixture.storedSourceText !== undefined) {
    const stored = createEvidenceExcerpt({
      sourceItemId: 1,
      role: fixture.role,
      sourceText: fixture.storedSourceText,
      candidate: fixture.candidateQuote,
    });
    return stored !== null && verifyEvidenceExcerpt({
      sourceItemId: 1,
      sourceText: fixture.sourceText,
      excerpt: stored,
    }) !== null;
  }
  const sample = sampleSourceText(fixture.sourceText, SAMPLE_BUDGET);
  return createEvidenceExcerpt({
    sourceItemId: 1,
    role: fixture.role,
    sourceText: fixture.sourceText,
    candidate: fixture.candidateQuote,
    visibleRanges: sample.windows,
  }) !== null;
}

export interface EvidenceQuoteEvalMetrics {
  cases: number;
  expectedContractPasses: number;
  accepted: number;
  correctAccepts: number;
  falseAccepts: number;
  missedValidQuotes: number;
  bodyGroundingWindowVersionContractAccuracy: number;
  syntheticContractPrecision: number | null;
  falseAcceptBreakdown: { fabricatedOrMismatch: number; titleOnly: number; hiddenMiddle: number; stale: number };
  tailCases: number;
  legacyTailVisible: number;
  candidateTailVisible: number;
  staleCases: number;
  staleRejected: number;
}

export interface EvidenceQuoteEvalResult {
  baselineCommit: string;
  candidateRevision: string | null;
  candidateTreeDirty: boolean | null;
  excerptAlgorithmVersion: string;
  fixtureHash: string;
  fixtureVersion: string;
  fixtureSetType: 'synthetic_regression_suite_created_after_candidate';
  heldoutWasUsedForTuning: false;
  model: null;
  metrics: Record<'all' | 'tuning' | 'holdout', { baseline: EvidenceQuoteEvalMetrics; candidate: EvidenceQuoteEvalMetrics }>;
  unavailableMetrics: string[];
}

function metricsFor(fixtures: EvidenceQuoteEvalFixture[], accepts: (fixture: EvidenceQuoteEvalFixture) => boolean): EvidenceQuoteEvalMetrics {
  let accepted = 0;
  let correctAccepts = 0;
  let falseAccepts = 0;
  let missedValidQuotes = 0;
  let legacyTailVisible = 0;
  let candidateTailVisible = 0;
  let staleCases = 0;
  let staleRejected = 0;
  const falseAcceptBreakdown = { fabricatedOrMismatch: 0, titleOnly: 0, hiddenMiddle: 0, stale: 0 };
  const tails = fixtures.filter((fixture) => fixture.scenario.includes('tail'));
  for (const fixture of fixtures) {
    const result = accepts(fixture);
    if (result) {
      accepted++;
      if (fixture.expectedGrounded) correctAccepts++;
      else {
        falseAccepts++;
        if (/fabricat|mismatch|empty_normalized/i.test(fixture.scenario)) falseAcceptBreakdown.fabricatedOrMismatch++;
        else if (fixture.scenario.includes('title_only')) falseAcceptBreakdown.titleOnly++;
        else if (fixture.scenario.includes('middle')) falseAcceptBreakdown.hiddenMiddle++;
        else if (fixture.storedSourceText !== undefined) falseAcceptBreakdown.stale++;
      }
    } else if (fixture.expectedGrounded) missedValidQuotes++;
    if (fixture.storedSourceText !== undefined) {
      staleCases++;
      if (!result) staleRejected++;
    }
  }
  for (const fixture of tails) {
    if (baselinePromptSawQuote(fixture)) legacyTailVisible++;
    if (candidatePromptSawQuote(fixture)) candidateTailVisible++;
  }
  const expectedGrounded = fixtures.filter((fixture) => fixture.expectedGrounded).length;
  const correctRejects = fixtures.length - expectedGrounded - falseAccepts;
  return {
    cases: fixtures.length,
    expectedContractPasses: expectedGrounded,
    accepted,
    correctAccepts,
    falseAccepts,
    missedValidQuotes,
    bodyGroundingWindowVersionContractAccuracy: fixtures.length ? (correctAccepts + correctRejects) / fixtures.length : 0,
    syntheticContractPrecision: accepted ? correctAccepts / accepted : null,
    falseAcceptBreakdown,
    tailCases: tails.length,
    legacyTailVisible,
    candidateTailVisible,
    staleCases,
    staleRejected,
  };
}

export function evaluateEvidenceQuoteFixtures(input: {
  candidateRevision?: string | null;
  candidateTreeDirty?: boolean | null;
} = {}): EvidenceQuoteEvalResult {
  const fixtures = EVIDENCE_QUOTE_EVAL_FIXTURES;
  const fixtureHash = createHash('sha256').update(JSON.stringify(fixtures), 'utf8').digest('hex');
  const evaluateSplit = (split: 'tuning' | 'holdout') => {
    const group = fixtures.filter((fixture) => fixture.split === split);
    return {
      baseline: metricsFor(group, baselineAccepts),
      candidate: metricsFor(group, candidateAccepts),
    };
  };
  return {
    baselineCommit: '675ef394c2a1157700be0930c2d05714ad4f1a32',
    candidateRevision: input.candidateRevision ?? null,
    candidateTreeDirty: input.candidateTreeDirty ?? null,
    excerptAlgorithmVersion: 'evidence-excerpts-v1',
    fixtureHash,
    fixtureVersion: EVIDENCE_QUOTE_EVAL_VERSION,
    fixtureSetType: 'synthetic_regression_suite_created_after_candidate',
    heldoutWasUsedForTuning: false,
    model: null,
    metrics: {
      all: {
        baseline: metricsFor(fixtures, baselineAccepts),
        candidate: metricsFor(fixtures, candidateAccepts),
      },
      tuning: evaluateSplit('tuning'),
      holdout: evaluateSplit('holdout'),
    },
    unavailableMetrics: [
      'Human-labeled top-candidate/opportunity precision: no human-labeled generated opportunity outputs.',
      'Problem-clustering overmerge and oversplit rates: T5 implementation and annotated outputs do not exist yet.',
      'Repeated opportunity rate: no production pipeline run was performed for this evaluation.',
      'Cost per useful candidate: no LLM calls or comparable usage records were collected.',
      'User-approved opportunities versus automatic evidence-gate decisions: no independent human adjudication set.',
      'Missed-post rate: no independent complete source-post inventory.',
    ],
  };
}
