import { createHash } from "node:crypto";
import { holdoutCases } from "./holdout.js";
import { tuningCases } from "./tuning.js";
import type { EvaluationCase, EvaluationCategory, EvaluationManifest, ExpectedVerifiedEvidence } from "./types.js";

export { holdoutCases, tuningCases };
export type {
  EvaluationCase,
  EvaluationCategory,
  EvaluationManifest,
  EvaluationSourceFixture,
  ExpectedBehavior,
  ExpectedVerifiedEvidence,
  RejectedExcerpt,
} from "./types.js";

export const REQUIRED_EVALUATION_CATEGORIES: readonly EvaluationCategory[] = Object.freeze([
  "support",
  "opposition",
  "mixed",
  "no_evidence",
  "inaccessible_original",
  "provider_outage",
  "promotional_source",
  "suggestion_promotion",
  "duplicates",
  "dependent_sources",
  "fabricated_quote",
  "stale_quote",
  "misleading_snippet",
  "ambiguous_buyer",
  "source_instruction_injection",
  "budget_limit",
  "cancellation",
]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const evaluationFixtures = deepFreeze({
  tuning: tuningCases,
  holdout: holdoutCases,
});

export const evaluationManifest: EvaluationManifest = deepFreeze({
  caseSetId: "idea-maze-hypothesis-research-usefulness",
  caseSetVersion: "1.0.0",
  rubricVersion: "1.0.0",
  expectedBehaviorSha256: "13b7ccf965043c8dec05f7189b057308c996de9bd01171fb25dfd141bf517c26",
  tuningCaseIds: tuningCases.map(({ caseId }) => caseId),
  holdoutCaseIds: holdoutCases.map(({ caseId }) => caseId),
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const properties = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${properties.join(",")}}`;
}

/** SHA-256 over schema versions, split membership, fixture text, and gold expectations. */
export function computeExpectedBehaviorSha256(
  tuning: readonly EvaluationCase[] = tuningCases,
  holdout: readonly EvaluationCase[] = holdoutCases,
): string {
  const payload = {
    caseSetId: evaluationManifest.caseSetId,
    caseSetVersion: evaluationManifest.caseSetVersion,
    rubricVersion: evaluationManifest.rubricVersion,
    tuningCases: tuning,
    holdoutCases: holdout,
  };
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

const SAFE_FIXTURE_HOSTS = new Set(["example.com"]);

/**
 * Validate the manually curated corpus without executing or scoring an engine.
 * It checks fixture integrity, gold references, required coverage, and split
 * leakage; it does not assert that any research implementation performs well.
 */
export function validateEvaluationFixtures(
  tuning: readonly EvaluationCase[] = tuningCases,
  holdout: readonly EvaluationCase[] = holdoutCases,
): string[] {
  const issues: string[] = [];
  const all = [...tuning, ...holdout];
  if (all.length < 12 || all.length > 20) issues.push(`Expected 12-20 cases; found ${all.length}.`);

  const caseById = new Map<string, EvaluationCase>();
  for (const [split, cases] of [["tuning", tuning], ["holdout", holdout]] as const) {
    for (const item of cases) {
      if (item.split !== split) issues.push(`${item.caseId}: declared ${item.split} but stored in ${split}.`);
      if (caseById.has(item.caseId)) issues.push(`${item.caseId}: case ID is duplicated across the corpus.`);
      else caseById.set(item.caseId, item);
    }
  }

  const presentCategories = new Set(all.flatMap(({ categories }) => categories));
  for (const category of REQUIRED_EVALUATION_CATEGORIES) {
    if (!presentCategories.has(category)) issues.push(`Required category is missing: ${category}.`);
  }

  const tuningOriginals = new Set(tuning.flatMap((item) => item.sourceFixtures
    .filter(({ originalText }) => originalText !== null)
    .map(({ originalText }) => originalText as string)));

  for (const item of all) {
    const sources = new Map<string, EvaluationCase["sourceFixtures"][number]>();
    for (const source of item.sourceFixtures) {
      if (sources.has(source.sourceId)) issues.push(`${item.caseId}: duplicate source ID ${source.sourceId}.`);
      else sources.set(source.sourceId, source);
      try {
        const parsed = new URL(source.url);
        if (parsed.protocol !== "https:" || !SAFE_FIXTURE_HOSTS.has(parsed.hostname)) {
          issues.push(`${item.caseId}/${source.sourceId}: URL is outside the reserved example host.`);
        }
      } catch {
        issues.push(`${item.caseId}/${source.sourceId}: source URL is invalid.`);
      }
      if (!source.independenceGroupId.trim()) issues.push(`${item.caseId}/${source.sourceId}: independence group is empty.`);
      if (source.provenanceClass === "promotional_material" && !item.categories.includes("promotional_source")) {
        issues.push(`${item.caseId}/${source.sourceId}: promotional provenance is not tagged for review.`);
      }
      if (source.originalStatus === "available" && (!source.originalText || !source.retrievedAt)) {
        issues.push(`${item.caseId}/${source.sourceId}: available original lacks text or retrieval time.`);
      }
      if (source.originalStatus === "unavailable" && (source.originalText !== null || source.retrievedAt !== null)) {
        issues.push(`${item.caseId}/${source.sourceId}: unavailable original contains fetched content.`);
      }
      const snippetIds = new Set<string>();
      for (const snippet of source.snippets) {
        if (snippetIds.has(snippet.snippetId)) issues.push(`${item.caseId}: duplicate snippet ID ${snippet.snippetId}.`);
        snippetIds.add(snippet.snippetId);
        if (snippet.assessmentEligible !== false) issues.push(`${item.caseId}/${snippet.snippetId}: discovery snippet must be ineligible.`);
      }
      if (item.split === "holdout" && source.originalText !== null && tuningOriginals.has(source.originalText)) {
        issues.push(`${item.caseId}/${source.sourceId}: original text is reused from tuning.`);
      }
    }

    const goldEvidence = new Map<string, ExpectedVerifiedEvidence>();
    for (const evidence of item.expectedVerifiedEvidence) {
      if (goldEvidence.has(evidence.evidenceId)) issues.push(`${item.caseId}: duplicate expected evidence ID ${evidence.evidenceId}.`);
      goldEvidence.set(evidence.evidenceId, evidence);
      const source = sources.get(evidence.sourceId);
      if (!source) {
        issues.push(`${item.caseId}/${evidence.evidenceId}: source reference ${evidence.sourceId} is missing.`);
        continue;
      }
      if (source.originalStatus !== "available" || source.originalText === null) {
        issues.push(`${item.caseId}/${evidence.evidenceId}: expected verified evidence has no accessible original.`);
        continue;
      }
      if (source.provenanceClass === "promotional_material" && evidence.relationship !== "context") {
        issues.push(`${item.caseId}/${evidence.evidenceId}: promotional copy must remain contextual evidence.`);
      }
      const firstIndex = source.originalText.indexOf(evidence.quote);
      if (firstIndex < 0) issues.push(`${item.caseId}/${evidence.evidenceId}: expected quote is not grounded in its original.`);
      else if (source.originalText.indexOf(evidence.quote, firstIndex + 1) >= 0) {
        issues.push(`${item.caseId}/${evidence.evidenceId}: expected quote is ambiguous in its original.`);
      }
    }

    if (item.categories.includes("promotional_source")
      && !item.sourceFixtures.some(({ provenanceClass }) => provenanceClass === "promotional_material")) {
      issues.push(`${item.caseId}: promotional-source category lacks a promotional source fixture.`);
    }
    if (item.categories.includes("promotional_source")
      && (item.expected.outcome !== "insufficient_evidence"
        || item.expected.expectedIndependentSupportGroups.length > 0
        || item.expectedVerifiedEvidence.some(({ relationship }) => relationship !== "context"))) {
      issues.push(`${item.caseId}: promotional material must remain contextual and cannot establish demand.`);
    }
    if (item.expected.workflow === "provider_outage"
      && (item.expected.outcome !== "insufficient_evidence"
        || item.expected.terminalStatus !== "completed"
        || item.expected.stoppingReason !== "provider_unavailable"
        || !item.expected.requiredCoverageGapReasons.includes("provider_unavailable"))) {
      issues.push(`${item.caseId}: provider outage must be reported as a completed limited result with a coverage gap.`);
    }

    for (const rejected of item.rejectedExcerpts) {
      const source = sources.get(rejected.sourceId);
      if (!source) issues.push(`${item.caseId}: rejected excerpt references missing source ${rejected.sourceId}.`);
      else if (source.originalStatus === "available" && source.originalText?.includes(rejected.quote)) {
        issues.push(`${item.caseId}: rejected ${rejected.reason} quote is actually present in the current original.`);
      }
    }

    for (const evidenceId of item.expected.expectedCitedEvidenceIds) {
      if (!goldEvidence.has(evidenceId)) issues.push(`${item.caseId}: expected citation ${evidenceId} has no gold evidence record.`);
    }
    for (const sourceId of item.expected.mustNotCiteSourceIds) {
      if (!sources.has(sourceId)) issues.push(`${item.caseId}: exclusion references missing source ${sourceId}.`);
      if (item.expected.expectedCitedEvidenceIds.some((id) => goldEvidence.get(id)?.sourceId === sourceId)) {
        issues.push(`${item.caseId}: source ${sourceId} is both required and forbidden as a citation.`);
      }
    }
    for (const sourceId of item.expected.knownCounterEvidenceSourceIds) {
      if (!sources.has(sourceId)) issues.push(`${item.caseId}: known counterevidence references missing source ${sourceId}.`);
      if (!item.expectedVerifiedEvidence.some((evidence) => evidence.sourceId === sourceId && evidence.relationship === "contradicts")) {
        issues.push(`${item.caseId}: known counterevidence ${sourceId} lacks a grounded challenging excerpt.`);
      }
    }
    for (const sourceId of item.expected.withheldCounterEvidenceSourceIds ?? []) {
      if (!sources.has(sourceId)) issues.push(`${item.caseId}: withheld counterevidence references missing source ${sourceId}.`);
      if (item.expected.knownCounterEvidenceSourceIds.includes(sourceId)) {
        issues.push(`${item.caseId}: counterevidence ${sourceId} is both in scope and withheld.`);
      }
      if (!item.expectedVerifiedEvidence.some((evidence) => evidence.sourceId === sourceId && evidence.relationship === "contradicts")) {
        issues.push(`${item.caseId}: withheld counterevidence ${sourceId} lacks a grounded challenging excerpt.`);
      }
    }

    if ((item.expected.withheldCounterEvidenceSourceIds?.length ?? 0) > 0 && !item.executionScope) {
      issues.push(`${item.caseId}: withheld counterevidence requires an explicit execution scope.`);
    }
    if (item.executionScope) {
      const { reachableSourceIds, withheldSourceIds, stopAfterSourceId, stopReason } = item.executionScope;
      const reachable = new Set(reachableSourceIds);
      const withheld = new Set(withheldSourceIds);
      if (reachable.size !== reachableSourceIds.length || withheld.size !== withheldSourceIds.length) {
        issues.push(`${item.caseId}: execution scope contains duplicate source IDs.`);
      }
      for (const sourceId of reachableSourceIds) if (!sources.has(sourceId)) issues.push(`${item.caseId}: reachable execution source ${sourceId} is missing.`);
      for (const sourceId of withheldSourceIds) if (!sources.has(sourceId)) issues.push(`${item.caseId}: withheld execution source ${sourceId} is missing.`);
      for (const sourceId of reachable) if (withheld.has(sourceId)) issues.push(`${item.caseId}: execution source ${sourceId} is both reachable and withheld.`);
      if (!reachable.has(stopAfterSourceId)) issues.push(`${item.caseId}: stop event source ${stopAfterSourceId} is not reachable.`);
      if (withheld.size !== (item.expected.withheldCounterEvidenceSourceIds?.length ?? 0)
        || [...withheld].some((id) => !item.expected.withheldCounterEvidenceSourceIds?.includes(id))) {
        issues.push(`${item.caseId}: execution scope and withheld counterevidence expectations differ.`);
      }
      if (item.expected.expectedCitedEvidenceIds.some((id) => !reachable.has(goldEvidence.get(id)?.sourceId ?? ""))) {
        issues.push(`${item.caseId}: an expected citation is outside the execution scope.`);
      }
      if (item.expected.knownCounterEvidenceSourceIds.some((id) => !reachable.has(id))) {
        issues.push(`${item.caseId}: in-scope counterevidence is outside the execution scope.`);
      }
      const expectedGap = stopReason === "budget_exhausted" ? "budget_exhausted" : "cancelled";
      const expectedWorkflow = stopReason === "budget_exhausted" ? "budget_exhaustion" : "cancellation";
      if (!item.expected.requiredCoverageGapReasons.includes(expectedGap)
        || item.expected.workflow !== expectedWorkflow
        || (stopReason === "budget_exhausted" && item.expected.stoppingReason !== "limit_reached")
        || (stopReason === "cancelled" && (item.expected.stoppingReason !== "cancelled" || item.expected.terminalStatus !== "cancelled"))) {
        issues.push(`${item.caseId}: execution stop does not match expected coverage behavior.`);
      }
    }

    const expectedSupportGroups = new Set(item.expected.expectedCitedEvidenceIds
      .map((id) => goldEvidence.get(id))
      .filter((evidence) => evidence?.relationship === "supports")
      .map((evidence) => sources.get(evidence!.sourceId)?.independenceGroupId)
      .filter((group): group is string => Boolean(group)));
    if (expectedSupportGroups.size !== new Set(item.expected.expectedIndependentSupportGroups).size
      || [...expectedSupportGroups].some((group) => !item.expected.expectedIndependentSupportGroups.includes(group))) {
      issues.push(`${item.caseId}: expected independent support groups do not match cited support.`);
    }

    if (item.hypothesisKind === "active_model_suggested"
      && (!item.suggestionId || item.expected.expectedHypothesisOrigin !== "model_suggested"
        || item.expected.expectedSuggestionDisposition !== "active_with_provenance")) {
      issues.push(`${item.caseId}: promoted suggestion lacks accepted-ID provenance expectations.`);
    }
    if (item.hypothesisKind === "unaccepted_suggestion"
      && (!item.suggestionId || item.expected.expectedHypothesisOrigin !== null
        || item.expected.expectedSuggestionDisposition !== "remains_unaccepted"
        || item.expected.terminalStatus !== "not_started")) {
      issues.push(`${item.caseId}: unaccepted suggestion must remain inactive and not start a run.`);
    }
    if (item.hypothesisKind === "active_user_supplied" && item.expected.expectedHypothesisOrigin !== "user_supplied") {
      issues.push(`${item.caseId}: caller-supplied hypothesis origin is inconsistent.`);
    }
  }

  return issues;
}
