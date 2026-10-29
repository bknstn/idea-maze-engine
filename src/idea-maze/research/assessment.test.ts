import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { ResearchEvidence, ResearchRun, VerifiedEvidenceLink, WorkspaceRunLease } from "./contracts.js";
import { assessResearchRun } from "./assessment.js";
import { renderResearchResultMarkdown } from "./report-renderer.js";
import type { ResearchRepositories, ResearchIdKind } from "./repositories.js";
import { createResearchRepositories } from "./repositories.js";
import { initSchema } from "../scripts/lib/schema.js";
import { hashSourceText, recoverEvidenceQuote } from "../scripts/lib/evidence-excerpts.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});

interface Harness {
  db: Database.Database;
  repositories: ResearchRepositories;
  run: ResearchRun;
  hypothesisId: string;
  lease: WorkspaceRunLease;
}

function makeHarness(workspaceKey = "assessment-workspace", hypothesisCount = 1): Harness {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  initSchema(db);
  let nextId = 0;
  const repositories = createResearchRepositories({
    db,
    workspaceKey,
    clock: () => new Date("2026-10-28T10:00:00.000Z"),
    idFactory: (kind: ResearchIdKind) => `${workspaceKey}-${kind}-${++nextId}`,
  });
  const created = repositories.cases.create({
    intake: {
      ideaSummary: "A synthetic workflow helper.",
      targetUser: "Small workshop teams.",
      problem: "Recurring stock checks are hard to coordinate.",
      proposedSolution: "A low-friction stock check helper.",
      currentAlternatives: ["paper tally sheet", "shared spreadsheet"],
    },
    hypotheses: Array.from({ length: hypothesisCount }, (_, index) => ({ claim: `Small workshop teams repeat a stock check every week, claim ${index + 1}.` })),
  });
  const hypothesisId = created.hypothesisRevisions[0].hypothesisId;
  const plan = repositories.plans.create({
    caseId: created.caseId,
    caseRevision: created.revision,
    queries: [
      { text: "Synthetic stock check experiences", purpose: "problem_language", evidenceIntent: "supporting", hypothesisIds: created.hypothesisRevisions.map((hypothesis) => hypothesis.hypothesisId), sourceScopes: ["public_web"] },
      { text: "Synthetic stock check counterexamples", purpose: "counterevidence", evidenceIntent: "challenging", hypothesisIds: created.hypothesisRevisions.map((hypothesis) => hypothesis.hypothesisId), sourceScopes: ["public_web"] },
    ],
    limits: { maxQueries: 2, maxFetchedPages: 4, maxFollowUpRounds: 1, maxWallTimeSeconds: 60, maxModelInputTokens: 2_000, maxModelOutputTokens: 1_000 },
  });
  const run = repositories.runs.create({ caseId: created.caseId, caseRevision: created.revision, planId: plan.planId });
  const lease = repositories.leases.acquire({ runId: run.runId, ownerInstanceId: `${workspaceKey}-worker`, ttlMilliseconds: 60_000 });
  return { db, repositories, run, hypothesisId, lease };
}

function saveVerifiedEvidence(
  harness: Harness,
  input: { evidenceId: string; relationship: VerifiedEvidenceLink["relationship"]; text: string; quote: string; externalId?: string; url?: string },
): VerifiedEvidenceLink {
  const sourceItemId = Number(harness.db.prepare(`
    INSERT INTO source_items(source, external_id, text, timestamp_utc, ingested_at_utc, raw_path, content_hash)
    VALUES ('synthetic', ?, ?, '2026-10-28T00:00:00.000Z', '2026-10-28T00:00:00.000Z', 'synthetic', ?)
  `).run(input.externalId ?? input.evidenceId, input.text, hashSourceText(input.text)).lastInsertRowid);
  const retrievedAt = "2026-10-28T10:00:01.000Z";
  const canonicalUrl = input.url ?? `https://example.com/${input.evidenceId}`;
  const sourceTextHash = hashSourceText(input.text);
  harness.repositories.sources.saveVersion({
    runId: harness.run.runId,
    sourceItemId,
    sourceText: input.text,
    sourceTextHash,
    canonicalUrl,
    retrievedAt,
  }, harness.lease);
  const grounded = recoverEvidenceQuote(input.text, input.quote);
  if (!grounded) throw new Error("Synthetic quote did not match its source text.");
  const evidence: VerifiedEvidenceLink = {
    kind: "verified_excerpt",
    evidenceId: input.evidenceId,
    hypothesisId: harness.hypothesisId,
    relationship: input.relationship,
    source: { sourceId: `source_items:${sourceItemId}`, canonicalUrl, retrievedAt },
    excerpt: { version: 1, sourceItemId, role: "claim", ...grounded },
    verification: "matched_to_fetched_original",
    interpretation: `Synthetic interpretation for ${input.evidenceId}.`,
    // Deliberately identical labels demonstrate that the assessment recomputes.
    independenceGroupId: "stale-stored-group-label",
    independenceUncertain: true,
  };
  harness.repositories.evidence.save(harness.run.runId, evidence, harness.lease);
  return evidence;
}

function assess(harness: Harness) {
  return assessResearchRun({ repositories: harness.repositories, runId: harness.run.runId });
}

describe("research assessment", () => {
  it("returns a useful insufficient-evidence assessment for zero evidence and preserves provider gaps", () => {
    const harness = makeHarness();
    harness.repositories.runs.updateRuntime(harness.run.runId, {
      coverageGaps: [{ reason: "provider_unavailable", detail: "Synthetic search provider is unavailable.", queryId: null, hypothesisId: harness.hypothesisId }],
    }, harness.lease);

    const result = assess(harness);
    expect(result.outcome).toBe("insufficient_evidence");
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0].supportingEvidenceIds).toEqual([]);
    expect(result.claims[0].challengingEvidenceIds).toEqual([]);
    expect(result.claims[0].missingEvidence).toEqual(expect.arrayContaining([
      expect.stringContaining("directly supports"),
      expect.stringContaining("counterexamples"),
    ]));
    expect(result.coverageGaps.map((gap) => gap.reason)).toEqual(["provider_unavailable"]);
    expect(result.rationale).toContain("provider_unavailable");
    expect(result.rationale).toContain("Caller-provided alternatives");
    expect(result.rationale).toContain("not market evidence");
    expect(result.nextExperiment).toContain("paper tally sheet");
    expect(result.nextExperiment).toContain("counterexamples");
    expect(JSON.stringify(result)).not.toMatch(/probability|market score/i);

    harness.repositories.runs.updateRuntime(harness.run.runId, {
      coverageGaps: [{ reason: "no_results", detail: "Synthetic searches returned no matching results.", queryId: null, hypothesisId: harness.hypothesisId }],
    }, harness.lease);
    const noMatches = assess(harness);
    expect(noMatches.outcome).toBe("insufficient_evidence");
    expect(noMatches.coverageGaps.map((gap) => gap.reason)).toEqual(["no_results"]);
    expect(noMatches.coverageGaps.map((gap) => gap.reason)).not.toContain("provider_unavailable");
  });

  it("keeps supporting and challenging verified evidence visible in a mixed assessment", () => {
    const harness = makeHarness();
    const support = saveVerifiedEvidence(harness, {
      evidenceId: "evidence-support",
      relationship: "supports",
      text: "Synthetic workshop note: I repeat the stock check every week before ordering supplies.",
      quote: "I repeat the stock check every week",
    });
    const challenge = saveVerifiedEvidence(harness, {
      evidenceId: "evidence-challenge",
      relationship: "contradicts",
      text: "Synthetic workshop note: our team checks stock once each month and has no weekly stock check.",
      quote: "our team checks stock once each month",
    });

    const result = assess(harness);
    expect(result.outcome).toBe("mixed");
    expect(result.claims[0].outcome).toBe("mixed");
    expect(result.claims[0].supportingEvidenceIds).toEqual([support.evidenceId]);
    expect(result.claims[0].challengingEvidenceIds).toEqual([challenge.evidenceId]);
    expect(result.claims[0].rationale).toContain("supportingEvidenceIds");
    expect(result.claims[0].rationale).toContain("challengingEvidenceIds");
  });

  it("keeps the overall outcome insufficient when another active claim remains unassessed", () => {
    const harness = makeHarness("assessment-multiple-claims", 2);
    saveVerifiedEvidence(harness, {
      evidenceId: "evidence-only-one-claim",
      relationship: "supports",
      text: "Synthetic workshop note: I repeat the stock check every week before ordering supplies.",
      quote: "I repeat the stock check every week",
    });

    const result = assess(harness);
    expect(result.claims.map((claim) => claim.outcome)).toEqual(["supported", "insufficient_evidence"]);
    expect(result.outcome).toBe("insufficient_evidence");
    expect(result.summary).toContain("At least one active claim still lacks direct verified support or counterevidence");
    expect(result.summary).not.toContain("No verified excerpt directly supports or challenges");
  });

  it("includes the old snapshotted claim text after the case is revised", () => {
    const harness = makeHarness("assessment-claim-snapshot");
    const oldClaim = harness.run.snapshot.caseRevision.hypothesisRevisions[0].claim;
    const updatedClaim = "A revised synthetic claim that only applies to monthly counts.";
    harness.repositories.cases.update({
      caseId: harness.run.caseId,
      expectedRevision: harness.run.caseRevision,
      hypothesisMutations: [{
        operation: "revise",
        hypothesisId: harness.hypothesisId,
        expectedRevision: 1,
        claim: updatedClaim,
      }],
    });

    const result = assess(harness);
    expect(result.claims[0].rationale).toContain(`Claim: “${oldClaim}”.`);
    expect(result.claims[0].rationale).not.toContain(updatedClaim);
    expect(result.claims[0].rationale.length).toBeLessThanOrEqual(2_000);
    const markdown = renderResearchResultMarkdown({ assessment: result, evidence: [], coverageGaps: result.coverageGaps });
    expect(markdown).toContain(oldClaim.replace(/\./g, "\\."));
    expect(markdown).not.toContain(updatedClaim);
  });

  it("does not let context excerpts or search snippets prove a claim", () => {
    const harness = makeHarness();
    const contextual = saveVerifiedEvidence(harness, {
      evidenceId: "evidence-context",
      relationship: "context",
      text: "Synthetic context: workshop staff use a clipboard near the supply shelf.",
      quote: "use a clipboard near the supply shelf",
    });
    const queryId = harness.run.snapshot.plan.queries[0].queryId;
    const snippet: ResearchEvidence = {
      kind: "search_snippet",
      snippetId: "snippet-support-looking",
      queryId,
      sourceUrl: "https://example.com/synthetic-snippet",
      text: "Synthetic snippet claims that all workshops have this problem.",
      assessmentEligible: false,
    };
    harness.repositories.evidence.save(harness.run.runId, snippet, harness.lease);

    const result = assess(harness);
    expect(result.outcome).toBe("insufficient_evidence");
    expect(result.claims[0].supportingEvidenceIds).toEqual([]);
    expect(result.claims[0].challengingEvidenceIds).toEqual([]);
    expect(result.claims[0].rationale).toContain("Context-only excerpts (1)");
    expect(result.rationale).toContain("Search snippets were treated as discovery leads only");
    expect(result.claims[0].rationale).not.toContain(contextual.evidenceId);
  });

  it("recomputes source groups across the complete run evidence set instead of trusting stored labels", () => {
    const harness = makeHarness();
    const copiedSourceText = "Synthetic workshop account: I repeat this stock check every week before ordering supplies, then write the count on the same shared board.";
    saveVerifiedEvidence(harness, {
      evidenceId: "evidence-copy-a",
      relationship: "supports",
      text: copiedSourceText,
      quote: "I repeat this stock check every week",
      externalId: "copy-a",
      url: "https://example.com/copied-a",
    });
    saveVerifiedEvidence(harness, {
      evidenceId: "evidence-copy-b",
      relationship: "supports",
      text: copiedSourceText,
      quote: "I repeat this stock check every week",
      externalId: "copy-b",
      url: "https://example.net/copied-b",
    });

    const result = assess(harness);
    expect(result.claims[0].outcome).toBe("supported");
    expect(result.claims[0].supportingEvidenceIds).toEqual(["evidence-copy-a", "evidence-copy-b"]);
    expect(result.claims[0].rationale).toContain("1 recomputed source group");
    expect(result.rationale).toContain("complete run set contains 1 recomputed source group");
    expect(result.rationale).toContain("confirmed independent authorship is unavailable");
  });

  it("rejects persisted evidence whose original or excerpt no longer verifies", () => {
    const harness = makeHarness();
    const evidence = saveVerifiedEvidence(harness, {
      evidenceId: "evidence-grounded",
      relationship: "supports",
      text: "Synthetic workshop note: I repeat the stock check every week before ordering supplies.",
      quote: "I repeat the stock check every week",
    });
    const invalid = { ...evidence, excerpt: { ...evidence.excerpt, quote: "a fabricated quote" } };
    const guardedRepositories = {
      ...harness.repositories,
      evidence: {
        ...harness.repositories.evidence,
        list: (_runId: string) => [invalid],
      },
    } as ResearchRepositories;

    expect(() => assessResearchRun({ repositories: guardedRepositories, runId: harness.run.runId }))
      .toThrow("could not be verified against its fetched original");
  });
});
