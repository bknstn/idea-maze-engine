import { describe, expect, it } from "vitest";
import {
  computeExpectedBehaviorSha256,
  evaluationManifest,
  holdoutCases,
  REQUIRED_EVALUATION_CATEGORIES,
  tuningCases,
  validateEvaluationFixtures,
} from "./evaluation/index.js";
import type { EvaluationCase } from "./evaluation/types.js";
import {
  calculateRuntimePercentiles,
  computeEvaluationFreezeSha256,
  runHypothesisResearchEvaluation,
} from "./evaluation/runner.js";

describe("hypothesis research evaluation fixtures", () => {
  it("runs a tuning fixture through the real application path with offline provider doubles", async () => {
    const report = await runHypothesisResearchEvaluation({ cases: [tuningCases[0]!] });
    const row = report.cases[0]!;

    expect(report.split).toBe("tuning");
    expect(report.rowsAreEngineUsefulnessEvidence).toBe(false);
    expect(report.expectedBehaviorSha256).toBe(evaluationManifest.expectedBehaviorSha256);
    expect(row.executionScope).toBe("real_application_mocked_provider_regression");
    expect(row.observed.terminalStatus).toBe("completed");
    expect(row.observed.outcome).toBe("supported");
    expect(row.evidenceProvenance.emittedVerifiedLinkCount).toBe(1);
    expect(row.evidenceProvenance.invalidLinkCount).toBe(0);
    expect(row.comparisons.expectedCitationIdsMatched).toEqual(["t01-e1"]);
    expect(row.unsupportedConclusions).toMatchObject({
      automated: false,
      manualReviewRequired: true,
      reviewedConclusionCount: null,
      unsupportedConclusionCount: null,
    });
    expect(row.observed.usage).toMatchObject({
      modelInputTokens: null,
      modelOutputTokens: null,
      providerCostMicros: null,
    });
    expect(report.aggregates.outcomeAgreement).toMatchObject({ numerator: 1, denominator: 1 });
    expect(row.manualReview).toMatchObject({
      reviewRequired: true,
      assessmentSummary: expect.any(String),
      assessmentRationale: expect.any(String),
      claims: [expect.objectContaining({ rationale: expect.any(String) })],
    });
    expect(report.aggregates.runtimeByTerminalStatus).toEqual([
      expect.objectContaining({
        terminalStatus: "completed",
        caseCount: 1,
        runtimeAvailableCaseIds: [row.caseId],
        noRuntimeCaseIds: [],
        medianMilliseconds: expect.any(Number),
        p95Milliseconds: expect.any(Number),
      }),
    ]);
  });

  it("counts an expected citation only when the assessment cites the emitted verified link", async () => {
    const contextOnly = {
      ...tuningCases[0]!,
      hypothesis: "A hypothesis about an unrelated lunar shipping workflow",
    } as EvaluationCase;
    const report = await runHypothesisResearchEvaluation({ cases: [contextOnly] });
    const row = report.cases[0]!;

    expect(row.observed.verifiedEvidenceCount).toBe(1);
    expect(row.observed.assessmentCitationIds).toEqual([]);
    expect(row.evidenceProvenance.uncitedVerifiedEvidence).toMatchObject([
      { relationship: "context", reason: "context_not_in_assessment_claim_citations" },
    ]);
    expect(row.comparisons.expectedCitationIdsMatched).toEqual([]);
    expect(row.comparisons.expectedEvidenceIdsEmitted).toEqual([]);
    expect(report.aggregates.expectedCitationRecall).toMatchObject({ numerator: 0, denominator: 1 });
    expect(report.aggregates.uncitedVerifiedEvidence).toMatchObject({ numerator: 1, denominator: 1 });
    expect(row.observed.usage).toMatchObject({
      modelInputTokens: null,
      modelOutputTokens: null,
      providerCostMicros: null,
    });
  });

  it("requires the exact reviewed freeze fingerprint before loading holdout cases", async () => {
    await expect(runHypothesisResearchEvaluation({ split: "holdout" }))
      .rejects.toThrow(/requires --freeze-sha256/u);
    await expect(runHypothesisResearchEvaluation({ split: "holdout", reviewedFreezeSha256: "0".repeat(64) }))
      .rejects.toThrow(/requires --freeze-sha256/u);
    expect(computeEvaluationFreezeSha256()).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses midpoint median and nearest-rank p95, preserving unavailable runtime as null", () => {
    expect(calculateRuntimePercentiles([])).toEqual({ medianMilliseconds: null, p95Milliseconds: null });
    expect(calculateRuntimePercentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]))
      .toEqual({ medianMilliseconds: 10.5, p95Milliseconds: 19 });
  });

  it("reports null runtime percentiles for cases that never start a run", async () => {
    const notStarted = {
      ...tuningCases[3]!,
      caseId: "tuning-test-unaccepted-suggestion",
      hypothesisKind: "unaccepted_suggestion",
      suggestionId: "suggestion-test-unaccepted",
      expected: {
        ...tuningCases[3]!.expected,
        outcome: null,
        terminalStatus: "not_started",
        stoppingReason: null,
        expectedCitedEvidenceIds: [],
        knownCounterEvidenceSourceIds: [],
        requiredCoverageGapReasons: [],
        expectedIndependentSupportGroups: [],
        expectedHypothesisOrigin: null,
        expectedSuggestionDisposition: "remains_unaccepted",
      },
    } as EvaluationCase;
    const report = await runHypothesisResearchEvaluation({ cases: [notStarted] });

    expect(report.cases[0]?.observed.terminalStatus).toBe("not_started");
    expect(report.aggregates.runtimeByTerminalStatus).toEqual([
      {
        terminalStatus: "not_started",
        caseCount: 1,
        runtimeAvailableCaseIds: [],
        noRuntimeCaseIds: [notStarted.caseId],
        medianMilliseconds: null,
        p95Milliseconds: null,
        percentileMethod: "median_midpoint_average_p95_nearest_rank",
      },
    ]);
    expect(report.aggregates.usage.elapsedMilliseconds).toMatchObject({
      totalReported: null,
      reportingRuns: 0,
      unreportedRuns: 0,
      notApplicableCases: 1,
    });
  });

  it("keeps the reviewed corpus split, manifest IDs, versions, and digest stable", () => {
    expect(tuningCases).toHaveLength(8);
    expect(holdoutCases).toHaveLength(10);
    expect(evaluationManifest.caseSetVersion).toBe("1.0.0");
    expect(evaluationManifest.rubricVersion).toBe("1.0.0");
    expect(evaluationManifest.tuningCaseIds).toEqual(tuningCases.map(({ caseId }) => caseId));
    expect(evaluationManifest.holdoutCaseIds).toEqual(holdoutCases.map(({ caseId }) => caseId));
    expect(computeExpectedBehaviorSha256()).toBe(evaluationManifest.expectedBehaviorSha256);
    expect(Object.isFrozen(tuningCases[0].sourceFixtures[0])).toBe(true);

    const changed = tuningCases.map((item, index) => index === 0 ? { ...item, title: `${item.title} changed` } : item);
    expect(computeExpectedBehaviorSha256(changed, holdoutCases)).not.toBe(evaluationManifest.expectedBehaviorSha256);
  });

  it("validates all frozen cases without scoring engine behavior", () => {
    expect(validateEvaluationFixtures()).toEqual([]);
    const covered = new Set([...tuningCases, ...holdoutCases].flatMap(({ categories }) => categories));
    expect([...REQUIRED_EVALUATION_CATEGORIES].every((category) => covered.has(category))).toBe(true);
  });

  it("rejects missing required categories", () => {
    const withoutSupport = tuningCases.map((item) => ({
      ...item,
      categories: item.categories.filter((category) => category !== "support"),
    }));
    const withoutSupportHoldout = holdoutCases.map((item) => ({
      ...item,
      categories: item.categories.filter((category) => category !== "support"),
    }));
    const issues = validateEvaluationFixtures(withoutSupport, withoutSupportHoldout);
    expect(issues).toContain("Required category is missing: support.");
  });

  it("checks evidence references and exact quotation grounding", () => {
    const directSupport = tuningCases[0];
    const brokenQuote = {
      ...directSupport,
      expectedVerifiedEvidence: directSupport.expectedVerifiedEvidence.map((evidence) => ({
        ...evidence,
        quote: "This fabricated text is not in the source.",
      })),
    } as EvaluationCase;
    expect(validateEvaluationFixtures([brokenQuote, ...tuningCases.slice(1)], holdoutCases)
      .some((issue) => issue.includes("expected quote is not grounded"))).toBe(true);

    const brokenReference = {
      ...directSupport,
      expected: { ...directSupport.expected, expectedCitedEvidenceIds: ["missing-evidence"] },
    } as EvaluationCase;
    expect(validateEvaluationFixtures([brokenReference, ...tuningCases.slice(1)], holdoutCases)
      .some((issue) => issue.includes("has no gold evidence record"))).toBe(true);
  });

  it("keeps holdout content separate from tuning and rejects cross-split IDs", () => {
    const reusedTuningText = {
      ...tuningCases[0],
      caseId: "h99-reused-tuning",
      split: "holdout",
    } as EvaluationCase;
    const issues = validateEvaluationFixtures(tuningCases, [...holdoutCases, reusedTuningText]);
    expect(issues.some((issue) => issue.includes("original text is reused from tuning"))).toBe(true);

    const repeatedId = validateEvaluationFixtures(tuningCases, [...holdoutCases, tuningCases[0]]);
    expect(repeatedId.some((issue) => issue.includes("case ID is duplicated across the corpus"))).toBe(true);
  });

  it("does not treat snippets, suggestions, promotion, or withheld evidence as ordinary support", () => {
    const inaccessible = tuningCases.find(({ caseId }) => caseId === "t05-inaccessible-original")!;
    expect(inaccessible.sourceFixtures[0].snippets[0].assessmentEligible).toBe(false);
    expect(inaccessible.expected.mustNotCiteSourceIds).toContain("t05-post");

    const accepted = tuningCases.find(({ caseId }) => caseId === "t06-explicit-suggestion-promotion")!;
    expect(accepted.expected).toMatchObject({
      expectedHypothesisOrigin: "model_suggested",
      expectedSuggestionDisposition: "active_with_provenance",
    });
    const unaccepted = holdoutCases.find(({ caseId }) => caseId === "h09-unaccepted-suggestion")!;
    expect(unaccepted.expected).toMatchObject({ terminalStatus: "not_started", expectedSuggestionDisposition: "remains_unaccepted" });

    const promotional = holdoutCases.find(({ caseId }) => caseId === "h10-promotional-source")!;
    expect(promotional.expected.outcome).toBe("insufficient_evidence");
    expect(promotional.expected.expectedIndependentSupportGroups).toEqual([]);
    expect(promotional.sourceFixtures[0].provenanceClass).toBe("promotional_material");
    expect(promotional.expectedVerifiedEvidence[0].relationship).toBe("context");

    for (const id of ["t07-duplicate-pages", "h05-dependent-sources"]) {
      const item = [...tuningCases, ...holdoutCases].find(({ caseId }) => caseId === id)!;
      expect(new Set(item.sourceFixtures.map(({ independenceGroupId }) => independenceGroupId)).size).toBe(1);
      expect(item.expected.expectedIndependentSupportGroups).toHaveLength(1);
    }

    for (const id of ["h07-budget-with-counterevidence-pending", "h08-cancel-after-partial-evidence"]) {
      const item = holdoutCases.find(({ caseId }) => caseId === id)!;
      expect(item.executionScope?.withheldSourceIds).toEqual(item.expected.withheldCounterEvidenceSourceIds);
      expect(item.expected.knownCounterEvidenceSourceIds).toEqual([]);
    }
  });

  it("requires an explicit schedule for counterevidence withheld by a stop", () => {
    const budgetCase = holdoutCases.find(({ caseId }) => caseId === "h07-budget-with-counterevidence-pending")!;
    const { executionScope: _executionScope, ...withoutScope } = budgetCase;
    const altered = holdoutCases.map((item) => item.caseId === budgetCase.caseId ? withoutScope as EvaluationCase : item);
    expect(validateEvaluationFixtures(tuningCases, altered)
      .some((issue) => issue.includes("withheld counterevidence requires an explicit execution scope"))).toBe(true);
  });

  it("keeps provider outages and promotional claims from becoming demand conclusions", () => {
    const outage = holdoutCases.find(({ caseId }) => caseId === "h06-provider-outage")!;
    expect(outage.expected).toMatchObject({
      outcome: "insufficient_evidence",
      terminalStatus: "completed",
      stoppingReason: "provider_unavailable",
      requiredCoverageGapReasons: ["provider_unavailable"],
    });
    const outageAsNegative = {
      ...outage,
      expected: { ...outage.expected, outcome: "contradicted" },
    } as EvaluationCase;
    const changedOutage = holdoutCases.map((item) => item.caseId === outage.caseId ? outageAsNegative : item);
    expect(validateEvaluationFixtures(tuningCases, changedOutage)
      .some((issue) => issue.includes("provider outage must be reported"))).toBe(true);

    const promotion = holdoutCases.find(({ caseId }) => caseId === "h10-promotional-source")!;
    const promotionalAsSupport = {
      ...promotion,
      expected: {
        ...promotion.expected,
        outcome: "supported",
        expectedIndependentSupportGroups: ["h10-vendor-page"],
      },
    } as EvaluationCase;
    const changedPromotion = holdoutCases.map((item) => item.caseId === promotion.caseId ? promotionalAsSupport : item);
    expect(validateEvaluationFixtures(tuningCases, changedPromotion)
      .some((issue) => issue.includes("promotional material must remain contextual"))).toBe(true);
  });
});
