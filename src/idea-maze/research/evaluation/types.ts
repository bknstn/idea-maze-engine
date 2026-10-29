import type { AssessmentOutcome, CoverageGapReason } from "../contracts.js";

export type EvaluationSplit = "tuning" | "holdout";

export type EvaluationCategory =
  | "support"
  | "opposition"
  | "mixed"
  | "no_evidence"
  | "inaccessible_original"
  | "provider_outage"
  | "promotional_source"
  | "suggestion_promotion"
  | "duplicates"
  | "dependent_sources"
  | "fabricated_quote"
  | "stale_quote"
  | "misleading_snippet"
  | "ambiguous_buyer"
  | "source_instruction_injection"
  | "budget_limit"
  | "cancellation";

export interface EvaluationSourceFixture {
  readonly sourceId: string;
  readonly url: string;
  readonly independenceGroupId: string;
  readonly originalStatus: "available" | "unavailable";
  readonly originalText: string | null;
  readonly retrievedAt: string | null;
  readonly provenanceClass: "community_or_user_material" | "promotional_material" | "unknown";
  readonly snippets: readonly {
    snippetId: string;
    text: string;
    assessmentEligible: false;
  }[];
}

export interface ExpectedVerifiedEvidence {
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly relationship: "supports" | "contradicts" | "context";
  readonly quote: string;
}

export interface RejectedExcerpt {
  readonly sourceId: string;
  readonly quote: string;
  readonly reason: "fabricated" | "stale_version";
}

export type EvaluationWorkflow =
  | "normal"
  | "explicit_suggestion_promotion"
  | "unaccepted_suggestion"
  | "provider_outage"
  | "budget_exhaustion"
  | "cancellation";

export interface ExpectedBehavior {
  /** Null when a run must not start or cannot produce an assessment. */
  readonly outcome: AssessmentOutcome | null;
  readonly terminalStatus: "completed" | "failed" | "cancelled" | "not_started";
  readonly stoppingReason: "all_steps_finished" | "provider_unavailable" | "limit_reached" | "cancelled" | null;
  readonly workflow: EvaluationWorkflow;
  readonly expectedCitedEvidenceIds: readonly string[];
  /** Gold counterevidence that the run should surface when execution reaches it. */
  readonly knownCounterEvidenceSourceIds: readonly string[];
  /** Known gold counterevidence deliberately outside this run's bounded execution scope. */
  readonly withheldCounterEvidenceSourceIds?: readonly string[];
  readonly requiredCoverageGapReasons: readonly CoverageGapReason[];
  readonly mustNotCiteSourceIds: readonly string[];
  readonly mustNotAssert: readonly string[];
  readonly expectedIndependentSupportGroups: readonly string[];
  readonly expectedHypothesisOrigin: "user_supplied" | "model_suggested" | null;
  readonly expectedSuggestionDisposition: "active_with_provenance" | "remains_unaccepted" | null;
}

/**
 * A frozen, synthetic case. Fixture facts and expected behavior are curated
 * separately from any engine output; this type does not represent a run.
 */
export interface EvaluationCase {
  readonly caseId: string;
  readonly split: EvaluationSplit;
  readonly title: string;
  readonly categories: readonly EvaluationCategory[];
  readonly ideaSummary: string;
  readonly hypothesis: string;
  readonly hypothesisKind: "active_user_supplied" | "active_model_suggested" | "unaccepted_suggestion";
  readonly suggestionId: string | null;
  readonly sourceFixtures: readonly EvaluationSourceFixture[];
  /** Explicit control boundary for resource-limited/cancelled executor fixtures. */
  readonly executionScope?: {
    readonly reachableSourceIds: readonly string[];
    readonly withheldSourceIds: readonly string[];
    readonly stopAfterSourceId: string;
    readonly stopReason: "budget_exhausted" | "cancelled";
  };
  readonly expectedVerifiedEvidence: readonly ExpectedVerifiedEvidence[];
  readonly rejectedExcerpts: readonly RejectedExcerpt[];
  readonly expected: ExpectedBehavior;
}

export interface EvaluationManifest {
  caseSetId: "idea-maze-hypothesis-research-usefulness";
  caseSetVersion: "1.0.0";
  rubricVersion: "1.0.0";
  expectedBehaviorSha256: string;
  tuningCaseIds: readonly string[];
  holdoutCaseIds: readonly string[];
}
