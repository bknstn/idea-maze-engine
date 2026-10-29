import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { hashSourceText } from "../../scripts/lib/evidence-excerpts.js";
import { createResearchRuntime } from "../runtime.js";
import type {
  AssessmentOutcome,
  CoverageGapReason,
  ResearchEvidence,
  ResearchAssessment,
  ResearchResultPage,
  RunStatusResult,
} from "../contracts.js";
import { ResearchProviderError, type ModelProvider, type ResearchProviderBindings, type SearchProvider } from "../ports.js";
import { SourceReaderError } from "../source-reader.js";
import { tuningCases } from "./tuning.js";
import type { EvaluationCase, EvaluationSplit, EvaluationSourceFixture } from "./types.js";

export const EVALUATION_RUBRIC_VERSION = "1.0.0" as const;
export const EVALUATION_CASE_SET_ID = "idea-maze-hypothesis-research-usefulness" as const;
export const EVALUATION_CASE_SET_VERSION = "1.0.0" as const;
export const FROZEN_EXPECTED_BEHAVIOR_SHA256 = "13b7ccf965043c8dec05f7189b057308c996de9bd01171fb25dfd141bf517c26";
export const EVALUATOR_POLICY_VERSION = "1.1.0" as const;

/**
 * The runner executes the real application/orchestrator/assessment path with
 * offline provider doubles. The classifier is intentionally generic and reads
 * only the hypothesis and retrieved original text. It never reads gold
 * evidence or expected behavior. These rows are policy/provenance regressions,
 * not model-classification accuracy or product-usefulness measurements.
 */
const EVALUATOR_POLICY = Object.freeze({
  version: EVALUATOR_POLICY_VERSION,
  execution: "createResearchRuntime; createCase; plan; start; poll; result; deterministic SQLite per case",
  providers: "offline synthetic search and source-reader; generic prompt/source-derived model double; no network calls",
  modelInterpretation: "token overlap plus generic negation and promotional-context rules; never reads gold fields",
  scoring: [
    "map fixture source IDs to emitted evidence by canonical URL and original SHA-256, then validate runtime IDs, verification state, quote, and UTF-16 range",
    "separate expected evidence emission from exact expected citations present in assessment claim citation IDs; report verified uncited evidence and its reason",
    "include assessment summary, rationale, claim rationales, and next experiment for independent manual unsupported-conclusion review",
    "compare exact assessment outcome, terminal state, stopping reason, coverage reasons, and in-scope counterevidence groups",
    "report source grouping counts and uncertainty; do not claim independent authorship",
    "do not automate free-text unsupported-conclusion review; preserve unknown provider usage as null",
    "report elapsed runtime by terminal status; median is the midpoint average and p95 uses nearest rank ceil(0.95*n)",
    "do not combine metrics into a synthetic pass rate",
  ],
});

export interface EvaluationMetricCount {
  numerator: number;
  denominator: number;
  rate: number | null;
  caseIds: string[];
}

export interface EvaluationUsageAggregate {
  totalReported: number | null;
  reportingRuns: number;
  unreportedRuns: number;
  notApplicableCases: number;
}

export interface RuntimePercentileSummary {
  medianMilliseconds: number | null;
  p95Milliseconds: number | null;
}

export function calculateRuntimePercentiles(values: readonly number[]): RuntimePercentileSummary {
  if (values.length === 0) return { medianMilliseconds: null, p95Milliseconds: null };
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError("Runtime samples must be finite non-negative milliseconds.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const medianMilliseconds = sorted.length % 2 === 0
    ? (sorted[midpoint - 1]! + sorted[midpoint]!) / 2
    : sorted[midpoint]!;
  const p95Index = Math.ceil(0.95 * sorted.length) - 1;
  return { medianMilliseconds, p95Milliseconds: sorted[p95Index]! };
}

export interface EvaluationCaseReport {
  caseId: string;
  split: EvaluationSplit;
  categories: EvaluationCase["categories"];
  executionScope: "real_application_mocked_provider_regression" | "real_application_not_started";
  runId: string | null;
  expected: {
    terminalStatus: EvaluationCase["expected"]["terminalStatus"];
    stoppingReason: EvaluationCase["expected"]["stoppingReason"];
    outcome: AssessmentOutcome | null;
    coverageGapReasons: CoverageGapReason[];
    expectedCitedEvidenceIds: string[];
    hypothesisOrigin: EvaluationCase["expected"]["expectedHypothesisOrigin"];
    suggestionDisposition: EvaluationCase["expected"]["expectedSuggestionDisposition"];
  };
  observed: {
    terminalStatus: RunStatusResult["status"] | "not_started";
    stoppingReason: RunStatusResult["stoppingReason"];
    outcome: AssessmentOutcome | null;
    coverageGapReasons: CoverageGapReason[];
    verifiedEvidenceCount: number | null;
    searchSnippetCount: number | null;
    verifiedEvidenceIds: string[];
    searchSnippetIds: string[];
    searchSnippetMappings: Array<{ runtimeSnippetId: string; fixtureSourceId: string | null; fixtureSnippetId: string | null }>;
    activeHypothesisRuntimeId: string | null;
    emittedEvidenceHypothesisIdsMatchCase: boolean | null;
    assessmentCitationIds: string[];
    elapsedMilliseconds: number | null;
    usage: RunStatusResult["usage"] | null;
    activeHypothesisOrigin: "user_supplied" | "model_suggested" | null;
    sourceSuggestionIdPreserved: boolean | null;
    suggestionDisposition: EvaluationCase["expected"]["expectedSuggestionDisposition"];
    modelSuggestionsReturned: number;
    runStarted: boolean;
  };
  comparisons: {
    terminalStatusMatches: boolean;
    stoppingReasonMatches: boolean;
    assessmentExpectationMatches: boolean;
    outcomeMatches: boolean | null;
    coverageReasonSetMatches: boolean;
    hypothesisOriginMatches: boolean;
    suggestionDispositionMatches: boolean;
    expectedCitationIdsMatched: string[];
    expectedCitationCount: number;
    matchedExpectedCitationCount: number;
    expectedEvidenceIdsEmitted: string[];
    matchedExpectedEvidenceEmissionCount: number;
    uncitedExpectedEvidenceIds: string[];
    unexpectedVerifiedEvidenceCount: number;
  };
  evidenceProvenance: {
    invalidLinkCount: number;
    emittedVerifiedLinkCount: number;
    invalidRate: number | null;
    errors: Array<{ evidenceId: string; checks: string[] }>;
    snippetCitationCount: number;
    danglingCitationCount: number;
    forbiddenSourceCitationIds: string[];
    unmappedSourceCount: number;
    uncitedVerifiedEvidence: Array<{
      evidenceId: string;
      relationship: Extract<ResearchEvidence, { kind: "verified_excerpt" }>["relationship"];
      reason: "assessment_unavailable" | "context_not_in_assessment_claim_citations" | "assessment_omitted_verified_link";
    }>;
  };
  manualReview: {
    reviewRequired: boolean;
    assessmentSummary: string | null;
    assessmentRationale: string | null;
    nextExperiment: string | null;
    claims: ResearchAssessment["claims"];
  };
  unsupportedConclusions: {
    automated: false;
    manualReviewRequired: boolean;
    reviewedConclusionCount: null;
    unsupportedConclusionCount: null;
  };
  counterevidence: {
    expectedInScopeGroupCount: number;
    expectedInScopeGroupIds: string[];
    observedChallengingGroupCount: number;
    observedChallengingGroupIds: string[];
    missedInScopeGroupIds: string[];
    withheldSourceCount: number;
    withheldGroupCount: number;
  };
  sourceGrouping: {
    expectedSupportGroupCount: number;
    expectedSupportGroupIds: string[];
    observedSupportGroupCount: number;
    observedSupportGroupIds: string[];
    supportGroupCountMatches: boolean | null;
    observedGroupsHaveUncertainAuthorship: boolean | null;
    fixtureMapping: "canonical_url_and_original_hash" | "incomplete" | "not_applicable";
  };
  harnessFailure: { stage: string; errorName: string } | null;
}

export interface EvaluationReport {
  reportVersion: "1.1.0";
  runDate: string;
  split: EvaluationSplit;
  caseSetId: typeof EVALUATION_CASE_SET_ID;
  caseSetVersion: typeof EVALUATION_CASE_SET_VERSION;
  expectedBehaviorSha256: string;
  rubricVersion: typeof EVALUATION_RUBRIC_VERSION;
  policyVersion: typeof EVALUATOR_POLICY_VERSION;
  policySha256: string;
  runnerSha256: string;
  evaluatorRevision: string;
  freezeSha256: string;
  engineRevision: string | null;
  rowsAreEngineUsefulnessEvidence: false;
  scopeStatement: string;
  fullSplitIncluded: boolean;
  cases: EvaluationCaseReport[];
  aggregates: {
    terminalStatusAgreement: EvaluationMetricCount;
    stoppingReasonAgreement: EvaluationMetricCount;
    assessmentExpectationAgreement: EvaluationMetricCount;
    outcomeAgreement: EvaluationMetricCount;
    coverageReasonSetAgreement: EvaluationMetricCount;
    hypothesisOriginAgreement: EvaluationMetricCount;
    suggestionDispositionAgreement: EvaluationMetricCount;
    evidenceProvenanceErrors: EvaluationMetricCount;
    expectedCitationRecall: EvaluationMetricCount;
    expectedEvidenceEmission: EvaluationMetricCount;
    uncitedVerifiedEvidence: EvaluationMetricCount;
    unexpectedVerifiedEvidence: EvaluationMetricCount;
    snippetMisuse: EvaluationMetricCount;
    missedKnownCounterevidenceGroups: EvaluationMetricCount;
    unsupportedConclusionReview: {
      automated: false;
      manualReviewRequiredCases: number;
      reviewedConclusions: null;
      unsupportedConclusions: null;
    };
    coverageByReason: Array<{ reason: CoverageGapReason; truePositive: number; falsePositive: number; falseNegative: number }>;
    terminalStatuses: Record<string, number>;
    usage: {
      searchRequests: EvaluationUsageAggregate;
      fetchedPages: EvaluationUsageAggregate;
      modelInputTokens: EvaluationUsageAggregate;
      modelOutputTokens: EvaluationUsageAggregate;
      providerCostMicros: EvaluationUsageAggregate;
      elapsedMilliseconds: EvaluationUsageAggregate;
    };
    runtimeByTerminalStatus: Array<{
      terminalStatus: RunStatusResult["status"] | "not_started";
      caseCount: number;
      runtimeAvailableCaseIds: string[];
      noRuntimeCaseIds: string[];
      medianMilliseconds: number | null;
      p95Milliseconds: number | null;
      percentileMethod: "median_midpoint_average_p95_nearest_rank";
    }>;
  };
}

export interface RunEvaluationOptions {
  /** Defaults to tuning; holdout requires a matching freeze SHA acknowledgment. */
  split?: EvaluationSplit;
  /** Test seam for a subset of tuning fixtures. Never accepted for holdout. */
  cases?: readonly EvaluationCase[];
  reviewedFreezeSha256?: string;
}

/** Hash of the frozen scorer and execution policy descriptor. */
export function computeEvaluatorPolicySha256(): string {
  return sha256(canonicalJson(EVALUATOR_POLICY));
}

/** Hash the runner implementation so a holdout acknowledgment is source-specific. */
export function computeEvaluationRunnerSha256(): string {
  return sha256(readFileSync(fileURLToPath(import.meta.url)));
}

export function computeEvaluationFreezeSha256(): string {
  return sha256([
    EVALUATION_CASE_SET_ID,
    EVALUATION_CASE_SET_VERSION,
    EVALUATION_RUBRIC_VERSION,
    FROZEN_EXPECTED_BEHAVIOR_SHA256,
    computeEvaluatorPolicySha256(),
    computeEvaluationRunnerSha256(),
  ].join("\n"));
}

/**
 * Run one split. Tuning is the default and does not import the holdout module.
 * A holdout run first requires an explicit matching freeze fingerprint, then
 * loads the frozen holdout records for the one authorized run.
 */
export async function runHypothesisResearchEvaluation(
  options: RunEvaluationOptions = {},
): Promise<EvaluationReport> {
  const split = options.split ?? "tuning";
  const policySha256 = computeEvaluatorPolicySha256();
  const runnerSha256 = computeEvaluationRunnerSha256();
  const freezeSha256 = computeEvaluationFreezeSha256();
  if (split === "holdout" && options.reviewedFreezeSha256 !== freezeSha256) {
    throw new Error(`Holdout execution requires --freeze-sha256 ${freezeSha256} after coordinator review.`);
  }
  if (split === "holdout" && options.cases) throw new TypeError("Custom case subsets cannot be used for holdout execution.");

  let selectedCases: readonly EvaluationCase[];
  if (options.cases) {
    selectedCases = options.cases;
  } else if (split === "tuning") {
    selectedCases = tuningCases;
  } else {
    const evaluation = await import("./index.js");
    const issues = evaluation.validateEvaluationFixtures();
    if (issues.length > 0) throw new Error(`The frozen corpus failed integrity checks: ${issues.join("; ")}`);
    const computed = evaluation.computeExpectedBehaviorSha256();
    if (computed !== FROZEN_EXPECTED_BEHAVIOR_SHA256) throw new Error("The frozen corpus digest does not match the reviewed version.");
    selectedCases = evaluation.holdoutCases;
  }
  if (selectedCases.some((item) => item.split !== split)) throw new TypeError(`The selected cases do not belong to the ${split} split.`);

  const cases: EvaluationCaseReport[] = [];
  for (const item of selectedCases) cases.push(await runCase(item));
  const fullSplitIncluded = split === "tuning" && selectedCases.length === 8
    ? selectedCases.every((item, index) => item.caseId === tuningCases[index]?.caseId)
    : split === "holdout" && selectedCases.length === 10;
  const engineRevision = readEngineRevision();
  return {
    reportVersion: "1.1.0",
    runDate: new Date().toISOString(),
    split,
    caseSetId: EVALUATION_CASE_SET_ID,
    caseSetVersion: EVALUATION_CASE_SET_VERSION,
    expectedBehaviorSha256: FROZEN_EXPECTED_BEHAVIOR_SHA256,
    rubricVersion: EVALUATION_RUBRIC_VERSION,
    policyVersion: EVALUATOR_POLICY_VERSION,
    policySha256,
    runnerSha256,
    evaluatorRevision: `sha256:${runnerSha256}`,
    freezeSha256,
    engineRevision,
    rowsAreEngineUsefulnessEvidence: false,
    scopeStatement: "Synthetic offline policy/provenance regression through the real application and assessment path with mocked search, original-source, and model providers. The mocked model also supplies the fixture hypothesis as a suggestion in suggestion scenarios. These rows do not measure model interpretation or suggestion accuracy, market demand, or product usefulness.",
    fullSplitIncluded,
    cases,
    aggregates: aggregate(cases),
  };
}

async function runCase(item: EvaluationCase): Promise<EvaluationCaseReport> {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "idea-maze-evaluation-"));
  const cancelReady = deferred<void>();
  let cancelReadySignaled = false;
  const signalCancelReady = () => {
    if (cancelReadySignaled) return;
    cancelReadySignaled = true;
    cancelReady.resolve();
  };
  let runtime: ReturnType<typeof createResearchRuntime> | null = null;
  let stage = "runtime_initialize";
  let runId: string | null = null;
  let finalStatus: RunStatusResult | null = null;
  let resultPage: ResearchResultPage | null = null;
  let modelSuggestionsReturned = 0;
  let activeHypothesisRuntimeId: string | null = null;
  let activeHypothesisOrigin: "user_supplied" | "model_suggested" | null = null;
  let sourceSuggestionIdPreserved: boolean | null = null;

  try {
    const providers = createEvaluationProviders(item, signalCancelReady, () => {
      modelSuggestionsReturned += 1;
    });
    runtime = createResearchRuntime({
      workspaceRoot,
      environment: { IDEA_MAZE_HOME: workspaceRoot },
      providers,
      limits: {
        maxQueries: 2,
        maxFetchedPages: Math.max(1, item.sourceFixtures.length),
        maxFollowUpRounds: 0,
        maxWallTimeSeconds: 30,
        maxModelInputTokens: 20_000,
        maxModelOutputTokens: 20_000,
      },
    });

    stage = "case_create";
    const createWithHypothesis = item.hypothesisKind === "active_user_supplied";
    const created = readData(await runtime.application.createCase({
      idempotencyKey: `evaluation-${item.caseId}-case`,
      intake: evaluationIntake(item),
      hypotheses: createWithHypothesis ? [{ claim: item.hypothesis, origin: "user_supplied" }] : [],
    }));
    let currentCase = created.case;

    if (item.hypothesisKind !== "active_user_supplied") {
      stage = "suggestion_plan";
      const suggestionPlan = readData(await runtime.application.plan({
        idempotencyKey: `evaluation-${item.caseId}-suggestions`,
        caseId: currentCase.caseId,
        expectedCaseRevision: currentCase.revision,
        requestHypothesisSuggestions: true,
      }));
      modelSuggestionsReturned = suggestionPlan.hypothesisSuggestions.length;
      if (item.hypothesisKind === "active_model_suggested") {
        const suggestion = suggestionPlan.hypothesisSuggestions[0];
        if (!suggestion) throw new Error("The offline suggestion provider returned no suggestion.");
        stage = "suggestion_acceptance";
        const accepted = readData(await runtime.application.updateCase({
          idempotencyKey: `evaluation-${item.caseId}-accept-suggestion`,
          caseId: currentCase.caseId,
          expectedRevision: currentCase.revision,
          hypothesisMutations: [{
            operation: "add",
            clientRef: "evaluation-hypothesis",
            claim: item.hypothesis,
            origin: "model_suggested",
            sourceSuggestionId: suggestion.suggestionId,
          }],
        }));
        currentCase = accepted.case;
      }
    }

    const activeHypothesis = currentCase.hypotheses.find((hypothesis) => hypothesis.state === "active");
    activeHypothesisRuntimeId = activeHypothesis?.hypothesisId ?? null;
    activeHypothesisOrigin = activeHypothesis?.origin ?? null;
    sourceSuggestionIdPreserved = activeHypothesis?.origin === "model_suggested"
      ? Boolean(activeHypothesis.sourceSuggestionId)
      : null;

    if (!activeHypothesis) {
      finalStatus = null;
      resultPage = null;
    } else {
      stage = "plan";
      const limits = limitsFor(item);
      const planned = readData(await runtime.application.plan({
        idempotencyKey: `evaluation-${item.caseId}-plan`,
        caseId: currentCase.caseId,
        expectedCaseRevision: currentCase.revision,
        suppliedPlan: {
          queries: [
            {
              text: "Synthetic evaluation query for described workflow support",
              purpose: "problem_language",
              evidenceIntent: "supporting",
              hypothesisIds: [activeHypothesis.hypothesisId],
              sourceScopes: ["public_web"],
            },
            {
              text: "Synthetic evaluation query for described workflow counterexamples",
              purpose: "counterevidence",
              evidenceIntent: "challenging",
              hypothesisIds: [activeHypothesis.hypothesisId],
              sourceScopes: ["public_web"],
            },
          ],
          limits,
        },
      }));
      if (!planned.plan) throw new Error("The offline evaluation plan was not ready.");

      stage = "start";
      const started = readData(await runtime.application.start({
        idempotencyKey: `evaluation-${item.caseId}-start`,
        caseId: currentCase.caseId,
        expectedCaseRevision: currentCase.revision,
        planId: planned.plan.planId,
      }));
      runId = started.runId;

      if (item.executionScope?.stopReason === "cancelled") {
        stage = "cancel";
        await waitFor(cancelReady.promise, 10_000, "The cancellation scenario did not reach its bounded stop point.");
        readData(await runtime.application.cancel({
          idempotencyKey: `evaluation-${item.caseId}-cancel`,
          runId,
        }));
      }

      stage = "poll";
      finalStatus = await pollUntilTerminal(runtime, runId, 15_000);
      stage = "result";
      resultPage = readData(await runtime.application.result({ runId, limit: 100, format: "json" }));
    }
  } catch (error) {
    const failure = { stage, errorName: error instanceof Error ? error.name : "UnknownError" };
    return buildCaseReport(item, runId, finalStatus, resultPage, activeHypothesisRuntimeId, activeHypothesisOrigin, sourceSuggestionIdPreserved, modelSuggestionsReturned, failure);
  } finally {
    try {
      await runtime?.shutdown();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }

  return buildCaseReport(item, runId, finalStatus, resultPage, activeHypothesisRuntimeId, activeHypothesisOrigin, sourceSuggestionIdPreserved, modelSuggestionsReturned, null);
}

function createEvaluationProviders(
  item: EvaluationCase,
  signalCancelReady: () => void,
  onSuggestion: () => void,
): ResearchProviderBindings {
  const allSources = orderedSources(item);
  const sourceByCanonicalUrl = new Map(item.sourceFixtures.map((source) => [canonicalUrl(source.url), source]));

  const search: SearchProvider = {
    async search(request) {
      if (item.categories.includes("provider_outage")) throw new ResearchProviderError("unavailable");
      let selected = allSources;
      if (item.executionScope?.stopReason === "budget_exhausted") {
        selected = request.purpose === "problem_language"
          ? item.executionScope.reachableSourceIds.map((id) => item.sourceFixtures.find((source) => source.sourceId === id)).filter((source): source is EvaluationSourceFixture => Boolean(source))
          : item.executionScope.withheldSourceIds.map((id) => item.sourceFixtures.find((source) => source.sourceId === id)).filter((source): source is EvaluationSourceFixture => Boolean(source));
      } else if (item.executionScope?.stopReason === "cancelled") {
        selected = request.purpose === "problem_language"
          ? item.executionScope.reachableSourceIds.map((id) => item.sourceFixtures.find((source) => source.sourceId === id)).filter((source): source is EvaluationSourceFixture => Boolean(source))
          : item.executionScope.withheldSourceIds.map((id) => item.sourceFixtures.find((source) => source.sourceId === id)).filter((source): source is EvaluationSourceFixture => Boolean(source));
      }
      // Return one stable lead per fixture source. The orchestrator applies its
      // own per-query bound and de-duplicates retrieval by canonical URL.
      return {
        results: selected.map((source) => ({
          url: source.url,
          title: "Synthetic evaluation source",
          snippet: source.snippets[0]?.text ?? "Synthetic discovery lead; original retrieval is required.",
        })),
        requestsUsed: 1,
        costMicros: null,
      };
    },
  };

  const reader: ResearchProviderBindings["originalSourceReader"]["provider"] = {
    async fetchOriginal({ url, signal }) {
      const source = sourceByCanonicalUrl.get(canonicalUrl(url));
      if (!source) throw new SourceReaderError("ORIGINAL_UNAVAILABLE", "original_unavailable", "Synthetic original is not part of this case.");
      if (item.executionScope?.stopReason === "cancelled" && item.executionScope.withheldSourceIds.includes(source.sourceId)) {
        signalCancelReady();
        await waitForAbort(signal);
      }
      if (source.originalStatus === "unavailable" || source.originalText === null) {
        throw new SourceReaderError("ORIGINAL_UNAVAILABLE", "original_unavailable", "Synthetic original is unavailable.");
      }
      return {
        canonicalUrl: canonicalUrl(source.url),
        retrievedAt: source.retrievedAt!,
        title: "Synthetic original source",
        contentType: "text/plain",
        text: source.originalText,
        textHash: hashSourceText(source.originalText),
      };
    },
  };

  const model: ModelProvider = {
    async generateJson<T>(request) {
      const prompt = parseJsonRecord(request.userPrompt);
      if (Array.isArray(prompt.sources)) {
        if (item.executionScope?.stopReason === "cancelled") {
          signalCancelReady();
          await waitForAbort(request.signal);
        }
        const hypotheses = Array.isArray(prompt.hypotheses) ? prompt.hypotheses : [];
        const sourceRows = prompt.sources as Array<Record<string, unknown>>;
        const claim = typeof hypotheses[0]?.claim === "string" ? hypotheses[0].claim : "";
        const value = {
          candidates: sourceRows.map((source, sourceIndex) => mockCandidate(claim, source, sourceIndex, String(hypotheses[0]?.hypothesisId ?? ""))),
        };
        return { value: value as T, usage: { inputTokens: null, outputTokens: null, costMicros: null } };
      }

      onSuggestion();
      return { value: { claims: [item.hypothesis] } as T, usage: { inputTokens: null, outputTokens: null, costMicros: null } };
    },
  };

  return {
    model: { availability: "available", adapter: "offline-evaluation-model", provider: model },
    search: { availability: "available", adapter: "offline-evaluation-search", provider: search },
    originalSourceReader: { availability: "available", adapter: "offline-evaluation-source-reader", provider: reader },
  };
}

function mockCandidate(claim: string, source: Record<string, unknown>, sourceIndex: number, hypothesisId: string): Record<string, unknown> {
  const text = typeof source.text === "string" ? source.text : "";
  if (text.length === 0) return {};
  const quoteEnd = Math.min(text.length, 800);
  const quote = text.slice(0, quoteEnd);
  const relation = mockRelationship(claim, text);
  return {
    sourceIndex,
    hypothesisId,
    relationship: relation,
    quote,
    startUtf16: 0,
    endUtf16: quote.length,
    interpretation: relation === "context"
      ? "The retrieved original provides context but has limited direct lexical overlap with the hypothesis."
      : `The retrieved original has lexical features that the offline mock interprets as ${relation === "supports" ? "supporting" : "challenging"} the hypothesis.`,
  };
}

function mockRelationship(claim: string, sourceText: string): "supports" | "contradicts" | "context" {
  const claimTerms = new Set(lexicalTerms(claim));
  const sourceTerms = new Set(lexicalTerms(sourceText));
  const overlap = [...claimTerms].filter((term) => sourceTerms.has(term)).length;
  const overlapRatio = claimTerms.size === 0 ? 0 : overlap / claimTerms.size;
  const promotional = /\b(?:our product|our platform|we offer|we sell|we provide|buy now|sign up today|our customers)\b/iu.test(sourceText);
  if (promotional) return "context";
  if (overlapRatio < 0.12 || overlap === 0) return "context";
  const explicitNegation = /\b(?:never|stopped using|no longer|don't|doesn't|didn't|cannot|can't|not using|not needed|no need)\b/iu.test(sourceText);
  return explicitNegation ? "contradicts" : "supports";
}

function lexicalTerms(value: string): string[] {
  const ignored = new Set(["about", "after", "again", "also", "been", "being", "from", "have", "into", "just", "more", "most", "often", "only", "that", "their", "them", "there", "these", "they", "this", "those", "through", "under", "until", "very", "were", "will", "with", "would", "your", "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "in", "is", "it", "of", "on", "or", "so", "the", "to", "up", "we"]);
  return (value.toLocaleLowerCase("en-US").match(/[a-z0-9]+/gu) ?? []).filter((term) => term.length > 2 && !ignored.has(term));
}

function orderedSources(item: EvaluationCase): EvaluationSourceFixture[] {
  if (!item.executionScope) return [...item.sourceFixtures];
  const ids = [...item.executionScope.reachableSourceIds, ...item.executionScope.withheldSourceIds];
  return ids.map((id) => item.sourceFixtures.find((source) => source.sourceId === id)).filter((source): source is EvaluationSourceFixture => Boolean(source));
}

function limitsFor(item: EvaluationCase) {
  const budgetStop = item.executionScope?.stopReason === "budget_exhausted";
  return {
    maxQueries: budgetStop ? 1 : 2,
    maxFetchedPages: Math.max(1, item.sourceFixtures.length),
    maxFollowUpRounds: 0,
    maxWallTimeSeconds: 30,
    maxModelInputTokens: 20_000,
    maxModelOutputTokens: 20_000,
  };
}

function evaluationIntake(item: EvaluationCase) {
  return {
    ideaSummary: item.ideaSummary,
    targetUser: "People described by this synthetic workflow case",
    problem: item.hypothesis,
    proposedSolution: `A possible workflow change related to: ${item.ideaSummary}`,
  };
}

async function pollUntilTerminal(
  runtime: ReturnType<typeof createResearchRuntime>,
  runId: string,
  timeoutMilliseconds: number,
): Promise<RunStatusResult> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const status = readData(await runtime.application.status({ runId }));
    if (["completed", "failed", "cancelled", "interrupted"].includes(status.status)) return status;
    await delay(5);
  }
  throw new Error("The offline evaluation run did not reach a terminal state.");
}

function buildCaseReport(
  item: EvaluationCase,
  runId: string | null,
  status: RunStatusResult | null,
  result: ResearchResultPage | null,
  activeHypothesisRuntimeId: string | null,
  activeHypothesisOrigin: "user_supplied" | "model_suggested" | null,
  sourceSuggestionIdPreserved: boolean | null,
  modelSuggestionsReturned: number,
  harnessFailure: EvaluationCaseReport["harnessFailure"],
): EvaluationCaseReport {
  const observedEvidence = result?.evidence ?? [];
  const verified = observedEvidence.filter((evidence): evidence is Extract<ResearchEvidence, { kind: "verified_excerpt" }> => evidence.kind === "verified_excerpt");
  const snippets = observedEvidence.filter((evidence) => evidence.kind === "search_snippet");
  const assessment = result?.assessment ?? null;
  const observedGaps = unique((result?.coverageGaps ?? status?.coverageGaps ?? []).map(({ reason }) => reason));
  const terminalStatus = status ? status.status : "not_started";
  const expectedGaps = unique([...item.expected.requiredCoverageGapReasons]);
  const assessmentCitations = assessment ? assessment.claims.flatMap((claim) => [...claim.supportingEvidenceIds, ...claim.challengingEvidenceIds]) : [];
  const fixtureByUrl = new Map(item.sourceFixtures.map((source) => [canonicalUrl(source.url), source]));
  const snippetMappings = snippets.map((snippet) => {
    const source = fixtureByUrl.get(canonicalUrl(snippet.sourceUrl));
    const fixtureSnippet = source?.snippets.find((entry) => entry.text === snippet.text);
    return {
      runtimeSnippetId: snippet.snippetId,
      fixtureSourceId: source?.sourceId ?? null,
      fixtureSnippetId: fixtureSnippet?.snippetId ?? null,
    };
  });
  const sourceByEvidence = new Map<string, EvaluationSourceFixture>();
  const provenanceErrors: EvaluationCaseReport["evidenceProvenance"]["errors"] = [];
  let unmappedSourceCount = 0;
  const evidenceMatches = new Map<string, string[]>();

  for (const link of verified) {
    const checks: string[] = [];
    const urlMatch = fixtureByUrl.get(canonicalUrl(link.source.canonicalUrl));
    const sourceHashMatches = urlMatch?.originalText !== null && urlMatch?.originalText !== undefined &&
      hashSourceText(urlMatch.originalText) === link.excerpt.sourceTextHash;
    const source = sourceHashMatches ? urlMatch : undefined;
    if (!urlMatch) {
      checks.push("source_url_not_in_fixture_input");
      unmappedSourceCount += 1;
    } else {
      if (!source) {
        checks.push(urlMatch.originalText === null ? "fixture_original_unavailable" : "original_hash_mismatch");
        unmappedSourceCount += 1;
      } else {
        sourceByEvidence.set(link.evidenceId, source);
        if (source.originalStatus !== "available") checks.push("fixture_original_unavailable");
        if (link.source.retrievedAt !== source.retrievedAt) checks.push("retrieval_time_mismatch");
        if (link.excerpt.startUtf16 < 0 || link.excerpt.endUtf16 <= link.excerpt.startUtf16 ||
            link.excerpt.endUtf16 > source.originalText!.length) checks.push("quote_range_out_of_bounds");
        if (source.originalText!.slice(link.excerpt.startUtf16, link.excerpt.endUtf16) !== link.excerpt.quote) checks.push("quote_range_mismatch");
        if (link.excerpt.sourceItemId < 1 || link.source.sourceId !== `source_items:${link.excerpt.sourceItemId}`) checks.push("runtime_source_id_mismatch");
      }
    }
    if (activeHypothesisRuntimeId && link.hypothesisId !== activeHypothesisRuntimeId) checks.push("hypothesis_id_not_active_case_hypothesis");
    if (link.verification !== "matched_to_fetched_original") checks.push("verification_state_mismatch");
    if (!checks.length && source) {
      const gold = item.expectedVerifiedEvidence.filter((expected) => expected.sourceId === source.sourceId &&
        expected.relationship === link.relationship && expected.quote === link.excerpt.quote &&
        item.expected.expectedCitedEvidenceIds.includes(expected.evidenceId));
      if (gold.length) evidenceMatches.set(link.evidenceId, gold.map(({ evidenceId }) => evidenceId));
    }
    if (checks.length) provenanceErrors.push({ evidenceId: link.evidenceId, checks });
  }

  const observedCitationIdsMatched = new Set<string>();
  for (const link of verified) {
    if (assessmentCitations.includes(link.evidenceId) && evidenceMatches.has(link.evidenceId)) {
      for (const goldId of evidenceMatches.get(link.evidenceId)!) observedCitationIdsMatched.add(goldId);
    }
  }
  const expectedCitations = [...item.expected.expectedCitedEvidenceIds];
  const expectedCitationMatched = expectedCitations.filter((id) => observedCitationIdsMatched.has(id));
  const emittedExpectedEvidenceIds = new Set([...evidenceMatches.values()].flat());
  const expectedEvidenceEmitted = expectedCitations.filter((id) => emittedExpectedEvidenceIds.has(id));
  const uncitedExpectedEvidenceIds = expectedEvidenceEmitted.filter((id) => !observedCitationIdsMatched.has(id));
  const unexpectedVerifiedEvidenceCount = verified.filter((link) => !evidenceMatches.has(link.evidenceId)).length;
  const snippetIds = new Set(snippets.map((evidence) => evidence.snippetId));
  const allResultEvidenceIds = new Set(observedEvidence.map((evidence) => evidence.kind === "verified_excerpt" ? evidence.evidenceId : evidence.snippetId));
  const snippetCitationCount = new Set(assessmentCitations.filter((id) => snippetIds.has(id))).size;
  const danglingCitationCount = new Set(assessmentCitations.filter((id) => !allResultEvidenceIds.has(id))).size;
  const citedEvidenceIds = new Set(assessmentCitations);
  const uncitedVerifiedEvidence = verified
    .filter((link) => !citedEvidenceIds.has(link.evidenceId))
    .map((link) => ({
      evidenceId: link.evidenceId,
      relationship: link.relationship,
      reason: !assessment
        ? "assessment_unavailable" as const
        : link.relationship === "context"
          ? "context_not_in_assessment_claim_citations" as const
          : "assessment_omitted_verified_link" as const,
    }));
  const forbiddenSourceIds = new Set(item.expected.mustNotCiteSourceIds);
  const forbiddenSourceCitationIds = verified
    .filter((link) => assessmentCitations.includes(link.evidenceId) && forbiddenSourceIds.has(sourceByEvidence.get(link.evidenceId)?.sourceId ?? ""))
    .map((link) => sourceByEvidence.get(link.evidenceId)!.sourceId);

  const observedOutcome = assessment?.outcome ?? null;
  const expectedAssessment = item.expected.outcome !== null;
  const assessmentExpectationMatches = expectedAssessment ? assessment !== null : assessment === null;
  const outcomeMatches = expectedAssessment && assessment ? assessment.outcome === item.expected.outcome : null;
  const terminalMatches = terminalStatus === item.expected.terminalStatus;
  const stoppingMatches = (status?.stoppingReason ?? null) === item.expected.stoppingReason;
  const coverageMatches = sameSet(expectedGaps, observedGaps);
  const observedSuggestionDisposition = activeHypothesisOrigin === "model_suggested" && sourceSuggestionIdPreserved
    ? "active_with_provenance"
    : activeHypothesisOrigin === null && modelSuggestionsReturned > 0 && runId === null
      ? "remains_unaccepted"
      : null;
  const hypothesisOriginMatches = activeHypothesisOrigin === item.expected.expectedHypothesisOrigin;
  const suggestionDispositionMatches = observedSuggestionDisposition === item.expected.expectedSuggestionDisposition;

  const knownCounterSources = new Set(item.expected.knownCounterEvidenceSourceIds);
  const expectedCounterGroups = new Set(item.sourceFixtures
    .filter((source) => knownCounterSources.has(source.sourceId))
    .map((source) => source.independenceGroupId));
  const observedChallengingGroups = new Set(verified
    .filter((link) => link.relationship === "contradicts" && assessmentCitations.includes(link.evidenceId))
    .map((link) => sourceByEvidence.get(link.evidenceId)?.independenceGroupId)
    .filter((group): group is string => Boolean(group)));
  const missedCounterGroups = [...expectedCounterGroups].filter((group) => !observedChallengingGroups.has(group));
  const withheldSources = item.expected.withheldCounterEvidenceSourceIds ?? [];
  const withheldGroups = new Set(item.sourceFixtures
    .filter((source) => withheldSources.includes(source.sourceId))
    .map((source) => source.independenceGroupId));

  const supportLinks = verified.filter((link) => link.relationship === "supports");
  const observedSupportGroups = new Set(supportLinks.map((link) => link.independenceGroupId));
  const supportGroupComparisonAvailable = item.expected.expectedIndependentSupportGroups.length > 0 || item.expectedVerifiedEvidence.some(({ relationship }) => relationship === "supports");
  const supportGroupMatches = supportGroupComparisonAvailable
    ? observedSupportGroups.size === item.expected.expectedIndependentSupportGroups.length
    : null;
  const groupAuthorshipUncertain = supportLinks.length > 0 ? supportLinks.every((link) => link.independenceUncertain === true) : null;
  const mappedAll = unmappedSourceCount === 0 && verified.every((link) => sourceByEvidence.has(link.evidenceId));

  return {
    caseId: item.caseId,
    split: item.split,
    categories: item.categories,
    executionScope: runId ? "real_application_mocked_provider_regression" : "real_application_not_started",
    runId,
    expected: {
      terminalStatus: item.expected.terminalStatus,
      stoppingReason: item.expected.stoppingReason,
      outcome: item.expected.outcome,
      coverageGapReasons: expectedGaps,
      expectedCitedEvidenceIds: [...item.expected.expectedCitedEvidenceIds],
      hypothesisOrigin: item.expected.expectedHypothesisOrigin,
      suggestionDisposition: item.expected.expectedSuggestionDisposition,
    },
    observed: {
      terminalStatus,
      stoppingReason: status?.stoppingReason ?? null,
      outcome: observedOutcome,
      coverageGapReasons: observedGaps,
      verifiedEvidenceCount: status ? verified.length : null,
      searchSnippetCount: status ? snippets.length : null,
      verifiedEvidenceIds: verified.map(({ evidenceId }) => evidenceId),
      searchSnippetIds: snippets.map(({ snippetId }) => snippetId),
      searchSnippetMappings: snippetMappings,
      activeHypothesisRuntimeId,
      emittedEvidenceHypothesisIdsMatchCase: verified.length === 0 ? null : verified.every((link) => link.hypothesisId === activeHypothesisRuntimeId),
      assessmentCitationIds: assessmentCitations,
      elapsedMilliseconds: status?.usage.elapsedMilliseconds ?? null,
      usage: status?.usage ?? null,
      activeHypothesisOrigin,
      sourceSuggestionIdPreserved,
      suggestionDisposition: observedSuggestionDisposition,
      modelSuggestionsReturned,
      runStarted: runId !== null,
    },
    comparisons: {
      terminalStatusMatches: terminalMatches,
      stoppingReasonMatches: stoppingMatches,
      assessmentExpectationMatches,
      outcomeMatches,
      coverageReasonSetMatches: coverageMatches,
      hypothesisOriginMatches,
      suggestionDispositionMatches,
      expectedCitationIdsMatched: expectedCitationMatched,
      expectedCitationCount: expectedCitations.length,
      matchedExpectedCitationCount: expectedCitationMatched.length,
      expectedEvidenceIdsEmitted: expectedEvidenceEmitted,
      matchedExpectedEvidenceEmissionCount: expectedEvidenceEmitted.length,
      uncitedExpectedEvidenceIds,
      unexpectedVerifiedEvidenceCount,
    },
    evidenceProvenance: {
      invalidLinkCount: provenanceErrors.length,
      emittedVerifiedLinkCount: verified.length,
      invalidRate: verified.length ? provenanceErrors.length / verified.length : null,
      errors: provenanceErrors,
      snippetCitationCount,
      danglingCitationCount,
      forbiddenSourceCitationIds: unique(forbiddenSourceCitationIds),
      unmappedSourceCount,
      uncitedVerifiedEvidence,
    },
    manualReview: {
      reviewRequired: assessment !== null,
      assessmentSummary: assessment?.summary ?? null,
      assessmentRationale: assessment?.rationale ?? null,
      nextExperiment: assessment?.nextExperiment ?? null,
      claims: assessment?.claims ?? [],
    },
    unsupportedConclusions: {
      automated: false,
      manualReviewRequired: assessment !== null,
      reviewedConclusionCount: null,
      unsupportedConclusionCount: null,
    },
    counterevidence: {
      expectedInScopeGroupCount: expectedCounterGroups.size,
      expectedInScopeGroupIds: [...expectedCounterGroups].sort(),
      observedChallengingGroupCount: observedChallengingGroups.size,
      observedChallengingGroupIds: [...observedChallengingGroups].sort(),
      missedInScopeGroupIds: missedCounterGroups,
      withheldSourceCount: withheldSources.length,
      withheldGroupCount: withheldGroups.size,
    },
    sourceGrouping: {
      expectedSupportGroupCount: item.expected.expectedIndependentSupportGroups.length,
      expectedSupportGroupIds: [...item.expected.expectedIndependentSupportGroups],
      observedSupportGroupCount: observedSupportGroups.size,
      observedSupportGroupIds: [...observedSupportGroups].sort(),
      supportGroupCountMatches: supportGroupMatches,
      observedGroupsHaveUncertainAuthorship: groupAuthorshipUncertain,
      fixtureMapping: verified.length === 0 ? "not_applicable" : mappedAll ? "canonical_url_and_original_hash" : "incomplete",
    },
    harnessFailure,
  };
}

function aggregate(cases: readonly EvaluationCaseReport[]): EvaluationReport["aggregates"] {
  const ratio = (rows: readonly EvaluationCaseReport[], select: (row: EvaluationCaseReport) => boolean, eligible = rows): EvaluationMetricCount => {
    const matching = eligible.filter(select);
    return { numerator: matching.length, denominator: eligible.length, rate: eligible.length ? matching.length / eligible.length : null, caseIds: matching.map(({ caseId }) => caseId) };
  };
  const assessmentRows = cases.filter((row) => row.expected.outcome !== null);
  const verifiedLinks = cases.reduce((total, row) => total + row.evidenceProvenance.emittedVerifiedLinkCount, 0);
  const invalidLinks = cases.reduce((total, row) => total + row.evidenceProvenance.invalidLinkCount, 0);
  const expectedCitationTotal = cases.reduce((total, row) => total + row.comparisons.expectedCitationCount, 0);
  const matchedCitationTotal = cases.reduce((total, row) => total + row.comparisons.matchedExpectedCitationCount, 0);
  const matchedEvidenceEmissionTotal = cases.reduce((total, row) => total + row.comparisons.matchedExpectedEvidenceEmissionCount, 0);
  const uncitedVerifiedLinks = cases.reduce((total, row) => total + row.evidenceProvenance.uncitedVerifiedEvidence.length, 0);
  const unexpectedEvidenceTotal = cases.reduce((total, row) => total + row.comparisons.unexpectedVerifiedEvidenceCount, 0);
  const snippetMisuseTotal = cases.reduce((total, row) => total + row.evidenceProvenance.snippetCitationCount, 0);
  const expectedCounterGroups = cases.reduce((total, row) => total + row.counterevidence.expectedInScopeGroupCount, 0);
  const missedCounterGroups = cases.reduce((total, row) => total + row.counterevidence.missedInScopeGroupIds.length, 0);
  const coverageReasons = unique(cases.flatMap((row) => [...row.expected.coverageGapReasons, ...row.observed.coverageGapReasons]));
  const coverageByReason = coverageReasons.map((reason) => {
    const truePositive = cases.filter((row) => row.expected.coverageGapReasons.includes(reason) && row.observed.coverageGapReasons.includes(reason)).length;
    const falsePositive = cases.filter((row) => !row.expected.coverageGapReasons.includes(reason) && row.observed.coverageGapReasons.includes(reason)).length;
    const falseNegative = cases.filter((row) => row.expected.coverageGapReasons.includes(reason) && !row.observed.coverageGapReasons.includes(reason)).length;
    return { reason, truePositive, falsePositive, falseNegative };
  });
  const values = (field: "searchRequests" | "fetchedPages" | "modelInputTokens" | "modelOutputTokens" | "providerCostMicros" | "elapsedMilliseconds") => {
    const rows = cases.filter((row) => row.observed.usage !== null);
    const reported = rows.map((row) => row.observed.usage![field]).filter((value): value is number => value !== null && value !== undefined);
    return {
      totalReported: reported.length ? reported.reduce((total, value) => total + value, 0) : null,
      reportingRuns: reported.length,
      unreportedRuns: rows.length - reported.length,
      notApplicableCases: cases.length - rows.length,
    };
  };
  const terminalStatuses: Record<string, number> = {};
  for (const row of cases) terminalStatuses[row.observed.terminalStatus] = (terminalStatuses[row.observed.terminalStatus] ?? 0) + 1;
  const runtimeByTerminalStatus = Object.keys(terminalStatuses).sort().map((terminalStatus) => {
    const matchingRows = cases.filter((row) => row.observed.terminalStatus === terminalStatus);
    const availableRows = matchingRows.filter((row) => row.observed.elapsedMilliseconds !== null);
    const summary = calculateRuntimePercentiles(availableRows.map((row) => row.observed.elapsedMilliseconds!));
    return {
      terminalStatus: terminalStatus as EvaluationCaseReport["observed"]["terminalStatus"],
      caseCount: matchingRows.length,
      runtimeAvailableCaseIds: availableRows.map(({ caseId }) => caseId),
      noRuntimeCaseIds: matchingRows.filter((row) => row.observed.elapsedMilliseconds === null).map(({ caseId }) => caseId),
      ...summary,
      percentileMethod: "median_midpoint_average_p95_nearest_rank" as const,
    };
  });
  const invalidLinkMetric: EvaluationMetricCount = {
    numerator: invalidLinks,
    denominator: verifiedLinks,
    rate: verifiedLinks ? invalidLinks / verifiedLinks : null,
    caseIds: cases.filter((row) => row.evidenceProvenance.invalidLinkCount > 0).map(({ caseId }) => caseId),
  };
  const citationRecall: EvaluationMetricCount = {
    numerator: matchedCitationTotal,
    denominator: expectedCitationTotal,
    rate: expectedCitationTotal ? matchedCitationTotal / expectedCitationTotal : null,
    caseIds: cases.filter((row) => row.comparisons.matchedExpectedCitationCount > 0).map(({ caseId }) => caseId),
  };
  const evidenceEmission: EvaluationMetricCount = {
    numerator: matchedEvidenceEmissionTotal,
    denominator: expectedCitationTotal,
    rate: expectedCitationTotal ? matchedEvidenceEmissionTotal / expectedCitationTotal : null,
    caseIds: cases.filter((row) => row.comparisons.matchedExpectedEvidenceEmissionCount > 0).map(({ caseId }) => caseId),
  };
  const uncitedEvidence: EvaluationMetricCount = {
    numerator: uncitedVerifiedLinks,
    denominator: verifiedLinks,
    rate: verifiedLinks ? uncitedVerifiedLinks / verifiedLinks : null,
    caseIds: cases.filter((row) => row.evidenceProvenance.uncitedVerifiedEvidence.length > 0).map(({ caseId }) => caseId),
  };
  const unexpectedMetric: EvaluationMetricCount = {
    numerator: unexpectedEvidenceTotal,
    denominator: verifiedLinks,
    rate: verifiedLinks ? unexpectedEvidenceTotal / verifiedLinks : null,
    caseIds: cases.filter((row) => row.comparisons.unexpectedVerifiedEvidenceCount > 0).map(({ caseId }) => caseId),
  };
  const snippetMisuse: EvaluationMetricCount = {
    numerator: snippetMisuseTotal,
    denominator: cases.reduce((total, row) => total + row.observed.assessmentCitationIds.length, 0),
    rate: cases.some((row) => row.observed.assessmentCitationIds.length > 0)
      ? snippetMisuseTotal / cases.reduce((total, row) => total + row.observed.assessmentCitationIds.length, 0)
      : null,
    caseIds: cases.filter((row) => row.evidenceProvenance.snippetCitationCount > 0).map(({ caseId }) => caseId),
  };
  return {
    terminalStatusAgreement: ratio(cases, (row) => row.comparisons.terminalStatusMatches),
    stoppingReasonAgreement: ratio(cases, (row) => row.comparisons.stoppingReasonMatches),
    assessmentExpectationAgreement: ratio(cases, (row) => row.comparisons.assessmentExpectationMatches),
    outcomeAgreement: ratio(cases, (row) => row.comparisons.outcomeMatches === true, assessmentRows),
    coverageReasonSetAgreement: ratio(cases, (row) => row.comparisons.coverageReasonSetMatches),
    hypothesisOriginAgreement: ratio(cases, (row) => row.comparisons.hypothesisOriginMatches),
    suggestionDispositionAgreement: ratio(
      cases.filter((row) => row.expected.suggestionDisposition !== null),
      (row) => row.comparisons.suggestionDispositionMatches,
    ),
    evidenceProvenanceErrors: invalidLinkMetric,
    expectedCitationRecall: citationRecall,
    expectedEvidenceEmission: evidenceEmission,
    uncitedVerifiedEvidence: uncitedEvidence,
    unexpectedVerifiedEvidence: unexpectedMetric,
    snippetMisuse,
    missedKnownCounterevidenceGroups: {
      numerator: missedCounterGroups,
      denominator: expectedCounterGroups,
      rate: expectedCounterGroups ? missedCounterGroups / expectedCounterGroups : null,
      caseIds: cases.filter((row) => row.counterevidence.missedInScopeGroupIds.length > 0).map(({ caseId }) => caseId),
    },
    unsupportedConclusionReview: {
      automated: false,
      manualReviewRequiredCases: cases.filter((row) => row.unsupportedConclusions.manualReviewRequired).length,
      reviewedConclusions: null,
      unsupportedConclusions: null,
    },
    coverageByReason,
    terminalStatuses,
    usage: {
      searchRequests: values("searchRequests"),
      fetchedPages: values("fetchedPages"),
      modelInputTokens: values("modelInputTokens"),
      modelOutputTokens: values("modelOutputTokens"),
      providerCostMicros: values("providerCostMicros"),
      elapsedMilliseconds: values("elapsedMilliseconds"),
    },
    runtimeByTerminalStatus,
  };
}

function readData<T>(response: { data?: T; error?: { code: string } }): T {
  if (!("data" in response)) throw new Error(`Application returned ${response.error?.code ?? "an unknown failure"}.`);
  return response.data as T;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((item) => b.has(item));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function readEngineRevision(): string | null {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function waitFor(promise: Promise<void>, milliseconds: number, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) throw signal.reason ?? new Error("Synthetic provider request was cancelled.");
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("Synthetic provider request was cancelled.")), { once: true });
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
