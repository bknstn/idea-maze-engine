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

describe("hypothesis research evaluation fixtures", () => {
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
