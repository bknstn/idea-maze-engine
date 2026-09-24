import { describe, expect, it } from 'vitest';

import { EVIDENCE_QUOTE_EVAL_FIXTURES } from './evidence-quote-eval-fixtures.ts';
import { evaluateEvidenceQuoteFixtures } from './evidence-quote-eval.ts';

describe('fixed synthetic evidence quote evaluation set', () => {
  it('has 24 tuning and 16 held-out cases with future clustering labels', () => {
    expect(EVIDENCE_QUOTE_EVAL_FIXTURES).toHaveLength(40);
    expect(EVIDENCE_QUOTE_EVAL_FIXTURES.filter((fixture) => fixture.split === 'tuning')).toHaveLength(24);
    expect(EVIDENCE_QUOTE_EVAL_FIXTURES.filter((fixture) => fixture.split === 'holdout')).toHaveLength(16);
    expect(EVIDENCE_QUOTE_EVAL_FIXTURES.every((fixture) => fixture.independentGroupId.length > 0)).toBe(true);
    expect(EVIDENCE_QUOTE_EVAL_FIXTURES.some((fixture) => fixture.scenario === 'same_words_different_problem')).toBe(true);
    expect(EVIDENCE_QUOTE_EVAL_FIXTURES.some((fixture) => fixture.scenario === 'same_problem_different_lexicon')).toBe(true);
  });

  it('compares frozen 675ef39 grounding with T3 on tuning and holdout without LLM calls', () => {
    const report = evaluateEvidenceQuoteFixtures();
    expect(report.heldoutWasUsedForTuning).toBe(false);
    expect(report.model).toBeNull();
    expect(report.baselineCommit).toBe('675ef394c2a1157700be0930c2d05714ad4f1a32');
    expect(report.excerptAlgorithmVersion).toBe('evidence-excerpts-v1');
    expect(report.fixtureSetType).toBe('synthetic_regression_suite_created_after_candidate');
    for (const split of ['tuning', 'holdout'] as const) {
      expect(report.metrics[split].candidate.falseAccepts).toBe(0);
      expect(report.metrics[split].candidate.missedValidQuotes).toBe(0);
      expect(report.metrics[split].candidate.staleRejected).toBe(report.metrics[split].candidate.staleCases);
      expect(report.metrics[split].candidate.candidateTailVisible).toBe(report.metrics[split].candidate.tailCases);
      expect(report.metrics[split].baseline.falseAccepts).toBeGreaterThan(0);
      expect(report.metrics[split].baseline.falseAcceptBreakdown.fabricatedOrMismatch).toBeGreaterThan(0);
      expect(report.metrics[split].baseline.falseAcceptBreakdown.titleOnly).toBe(1);
      expect(report.metrics[split].baseline.falseAcceptBreakdown.hiddenMiddle).toBe(1);
      expect(report.metrics[split].baseline.falseAcceptBreakdown.stale).toBe(1);
      expect(report.metrics[split].baseline.legacyTailVisible).toBe(0);
    }
    expect(report.unavailableMetrics).toContain('Cost per useful candidate: no LLM calls or comparable usage records were collected.');
  });
});
