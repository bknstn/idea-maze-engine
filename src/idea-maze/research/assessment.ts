import type {
  AssessmentOutcome,
  ClaimAssessment,
  CoverageGap,
  ResearchAssessment,
  ResearchRun,
  VerifiedEvidenceLink,
} from "./contracts.js";
import { groupEvidenceSources, type EvidenceSourceIdentity } from "./evidence-mapper.js";
import { RepositoryNotFoundError, type ResearchRepositories, type SourceVersionRecord } from "./repositories.js";
import { verifyResearchExcerpt } from "./provenance.js";

export interface ResearchAssessmentInput {
  repositories: ResearchRepositories;
  runId: string;
}

export class InvalidResearchAssessmentEvidenceError extends Error {
  constructor() {
    super("Assessment evidence could not be verified against its fetched original.");
    this.name = "InvalidResearchAssessmentEvidenceError";
  }
}

export class ResearchAssessmentLimitError extends Error {
  constructor() {
    super("The assessment exceeds the supported claim, evidence, or coverage bounds.");
    this.name = "ResearchAssessmentLimitError";
  }
}

/**
 * Produce a deterministic claim-level assessment from the complete run
 * evidence set. Search snippets are ignored. Every accepted factual evidence
 * reference is rechecked against its immutable fetched original before use.
 */
export function assessResearchRun(input: ResearchAssessmentInput): ResearchAssessment {
  // Read the run-scoped evidence set at the assessment boundary instead of
  // accepting caller-constructed links. The next assessment after a follow-up
  // sees every persisted link and recomputes source dependencies from scratch.
  const run = input.repositories.runs.get(input.runId);
  if (!run) throw new RepositoryNotFoundError("run", input.runId);
  const evidence = input.repositories.evidence.list(input.runId);
  const activeHypotheses = run.snapshot.caseRevision.hypothesisRevisions
    .filter((hypothesis) => hypothesis.state === "active");
  if (activeHypotheses.length > 20 || run.coverageGaps.length > 1_000 || run.coverageGaps.some((gap) =>
    gap.detail.length < 1 || gap.detail.length > 1_000 ||
    (gap.queryId !== null && gap.queryId.length > 128) ||
    (gap.hypothesisId !== null && gap.hypothesisId.length > 128))) {
    throw new ResearchAssessmentLimitError();
  }
  const activeById = new Map(activeHypotheses.map((hypothesis) => [hypothesis.hypothesisId, hypothesis]));
  const seenEvidenceIds = new Set<string>();
  const verifiedLinks: VerifiedEvidenceLink[] = [];
  const sourceIdentities: EvidenceSourceIdentity[] = [];

  for (const item of evidence) {
    const id = item.kind === "verified_excerpt" ? item.evidenceId : item.snippetId;
    if (seenEvidenceIds.has(id)) throw new InvalidResearchAssessmentEvidenceError();
    seenEvidenceIds.add(id);
    if (item.kind !== "verified_excerpt") continue;

    const hypothesis = activeById.get(item.hypothesisId);
    const sourceItemId = sourceItemIdFromReference(item.source.sourceId);
    const sourceVersion = sourceVersionFor(input.repositories, item);
    if (!hypothesis || !sourceVersion ||
        sourceItemId !== item.excerpt.sourceItemId ||
        sourceVersion.sourceItemId !== sourceItemId ||
        sourceVersion.sourceTextHash !== item.excerpt.sourceTextHash ||
        sourceVersion.retrievedAt !== item.source.retrievedAt ||
        sourceVersion.canonicalUrl !== item.source.canonicalUrl ||
        !verifyResearchExcerpt({
          sourceItemId,
          sourceText: sourceVersion.sourceText,
          excerpt: item.excerpt,
        })) {
      throw new InvalidResearchAssessmentEvidenceError();
    }

    verifiedLinks.push(item);
    sourceIdentities.push({
      evidenceId: item.evidenceId,
      source: item.source,
      sourceText: sourceVersion.sourceText,
    });
  }

  // Stored independenceGroupId values are immutable link metadata. Recompute
  // the graph from every source version so follow-ups can merge prior groups.
  const independence = groupEvidenceSources(sourceIdentities);
  const groupByEvidenceId = new Map<string, string>();
  for (const group of independence.groups) {
    for (const evidenceId of group.evidenceIds) groupByEvidenceId.set(evidenceId, group.groupId);
  }

  const claims = activeHypotheses.map((hypothesis): ClaimAssessment => {
    const links = verifiedLinks.filter((link) => link.hypothesisId === hypothesis.hypothesisId);
    const supporting = links.filter((link) => link.relationship === "supports");
    const challenging = links.filter((link) => link.relationship === "contradicts");
    const contextual = links.filter((link) => link.relationship === "context");
    const supportingGroups = distinctGroupCount(supporting, groupByEvidenceId);
    const challengingGroups = distinctGroupCount(challenging, groupByEvidenceId);
    const outcome = claimOutcome(supporting.length > 0, challenging.length > 0);
    if (supporting.length > 1_000 || challenging.length > 1_000) throw new ResearchAssessmentLimitError();
    const missingEvidence: string[] = [];

    if (supporting.length === 0) missingEvidence.push("Verified original-source evidence that directly supports this claim.");
    if (challenging.length === 0) missingEvidence.push("Verified counterexamples or boundary conditions that could challenge this claim.");
    if (supporting.length > 0 || challenging.length > 0) {
      missingEvidence.push("Information that establishes whether source groups represent distinct authors, if independent corroboration matters.");
    }

    const evidenceNotes = [
      `Supporting verified evidence IDs are listed in supportingEvidenceIds (${supporting.length} link${supporting.length === 1 ? "" : "s"}; ${supportingGroups} recomputed source group${supportingGroups === 1 ? "" : "s"}).`,
      `Challenging verified evidence IDs are listed in challengingEvidenceIds (${challenging.length} link${challenging.length === 1 ? "" : "s"}; ${challengingGroups} recomputed source group${challengingGroups === 1 ? "" : "s"}).`,
      `Context-only excerpts (${contextual.length}) are visible in paginated evidence and do not affect this claim outcome.`,
      "Source groups identify likely source dependencies; they do not establish independent authorship.",
    ];
    const claimLabel = `Claim: “${hypothesis.claim}”.`;
    const rationale = `${claimLabel} ${evidenceNotes.join(" ")}`.slice(0, 2_000);

    return {
      hypothesisId: hypothesis.hypothesisId,
      outcome,
      rationale,
      supportingEvidenceIds: supporting.map((link) => link.evidenceId).sort(),
      challengingEvidenceIds: challenging.map((link) => link.evidenceId).sort(),
      missingEvidence,
    };
  });

  const outcome = combinedOutcome(claims.map((claim) => claim.outcome));
  const summary = summaryFor(outcome, claims);
  const alternativesText = alternativesDisclosure(run.snapshot.caseRevision.intake.currentAlternatives);
  const gapText = run.coverageGaps.length === 0
    ? "No collection coverage gaps were recorded for this run."
    : `Recorded coverage gaps: ${[...new Set(run.coverageGaps.map((gap) => gap.reason))].join(", ")}. These describe what collection could not establish; they are not evidence for or against a claim.`;
  const independenceText = verifiedLinks.length === 0
    ? "No verified original excerpts were available to assess. Search snippets, if present, were excluded from claim outcomes."
    : `The complete run set contains ${independence.sourceGroupCount} recomputed source group${independence.sourceGroupCount === 1 ? "" : "s"}; confirmed independent authorship is unavailable.`;
  const snippetText = evidence.some((item) => item.kind === "search_snippet")
    ? "Search snippets were treated as discovery leads only and were excluded from claim outcomes."
    : "No search snippets were used as claim evidence.";

  return {
    outcome,
    summary,
    rationale: [
      "Outcomes summarize the recorded relationship interpretations for verified excerpts; provenance establishes quotation grounding, not whether an interpretation is true or broadly representative.",
      independenceText,
      snippetText,
      gapText,
      alternativesText,
    ].join(" ").slice(0, 4_000),
    claims,
    coverageGaps: run.coverageGaps,
    nextExperiment: nextExperiment(run, outcome, run.coverageGaps).slice(0, 2_000),
  };
}

function sourceVersionFor(repositories: ResearchRepositories, link: VerifiedEvidenceLink): SourceVersionRecord | null {
  const sourceItemId = sourceItemIdFromReference(link.source.sourceId);
  return repositories.sources.getVersion({
    sourceItemId,
    sourceTextHash: link.excerpt.sourceTextHash,
    retrievedAt: link.source.retrievedAt,
  });
}

function sourceItemIdFromReference(sourceId: string): number {
  const match = /^source_items:([1-9]\d{0,14})$/.exec(sourceId);
  if (!match) throw new InvalidResearchAssessmentEvidenceError();
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) throw new InvalidResearchAssessmentEvidenceError();
  return id;
}

function claimOutcome(hasSupport: boolean, hasChallenge: boolean): AssessmentOutcome {
  if (hasSupport && hasChallenge) return "mixed";
  if (hasSupport) return "supported";
  if (hasChallenge) return "contradicted";
  return "insufficient_evidence";
}

function combinedOutcome(outcomes: readonly AssessmentOutcome[]): AssessmentOutcome {
  const substantive = new Set(outcomes.filter((outcome) => outcome !== "insufficient_evidence"));
  if (substantive.has("mixed") || (substantive.has("supported") && substantive.has("contradicted"))) return "mixed";
  if (outcomes.includes("insufficient_evidence")) return "insufficient_evidence";
  if (substantive.has("supported")) return "supported";
  if (substantive.has("contradicted")) return "contradicted";
  return "insufficient_evidence";
}

function distinctGroupCount(links: readonly VerifiedEvidenceLink[], groupByEvidenceId: ReadonlyMap<string, string>): number {
  return new Set(links.map((link) => groupByEvidenceId.get(link.evidenceId)).filter((value): value is string => value !== undefined)).size;
}

function summaryFor(outcome: AssessmentOutcome, claims: readonly ClaimAssessment[]): string {
  switch (outcome) {
    case "supported": return "Verified excerpts are interpreted as supporting one or more active claims; this does not establish broader prevalence. See each claim's evidence ID lists.";
    case "mixed": return "The run contains both supporting and challenging interpretations, or claims with different evidence outcomes. See each claim's evidence ID lists.";
    case "contradicted": return "Verified excerpts are interpreted as challenging the active claims; this does not establish that the claims are false in every context. See each claim's evidence ID lists.";
    case "insufficient_evidence":
      if (claims.length === 0) return "No active claims were available for assessment.";
      if (claims.some((claim) => claim.supportingEvidenceIds.length > 0 || claim.challengingEvidenceIds.length > 0)) {
        return "At least one active claim still lacks direct verified support or counterevidence; see claim-level outcomes. This limited result is not evidence that the problem is absent.";
      }
      return "No verified excerpt directly supports or challenges an active claim. This result is limited and is not evidence that the problem is absent.";
  }
}

function alternativesDisclosure(alternatives: string[] | null | undefined): string {
  if (alternatives === undefined || alternatives === null) {
    return "No current alternatives were supplied; ask participants what they use or do today. An unknown alternative set is not evidence that no alternatives exist.";
  }
  if (alternatives.length === 0) {
    return "The caller explicitly listed no current alternatives. This intake statement is not a finding that alternatives do not exist.";
  }
  const shown = alternatives.map((alternative) => `“${alternative.slice(0, 300)}”`);
  return `Caller-provided alternatives to investigate (unverified intake context, not market evidence): ${shown.join("; ")}.`;
}

function nextExperiment(run: ResearchRun, outcome: AssessmentOutcome, gaps: readonly CoverageGap[]): string {
  const intake = run.snapshot.caseRevision.intake;
  const target = intake.targetUser?.trim();
  const audience = target ? `people matching “${target.slice(0, 200)}”` : "people who recently encountered the stated problem";
  const alternatives = intake.currentAlternatives;
  const comparison = alternatives && alternatives.length > 0
    ? ` Compare the current approach with the caller-listed alternatives (${alternatives.map((item) => item.slice(0, 100)).join("; ")}) and a low-fidelity version of the proposed solution.`
    : " Ask each person what they use or do today before showing a low-fidelity version of the proposed solution.";
  const unavailable = gaps.some((gap) => gap.reason === "provider_unavailable" || gap.reason === "search_failed" || gap.reason === "fetch_failed");
  const action = unavailable
    ? `First collect a small set of source-grounded examples manually or after collection access is restored with ${audience}; record both confirming examples and counterexamples.`
    : `Run structured interviews with five ${audience} and ask for a recent concrete instance, current workaround, and observable time or error impact.`;
  const followThrough = outcome === "mixed"
    ? "Include cases on both sides and identify which user or workflow conditions explain the difference."
    : "Record what would count as a disconfirming result before the interviews begin.";
  return `${action}${comparison} ${followThrough}`;
}
