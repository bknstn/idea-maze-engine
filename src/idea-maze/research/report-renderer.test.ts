import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { ResearchAssessment } from "./contracts.js";
import {
  createResearchResultService,
  InvalidResearchResultCursorError,
  MAX_RESEARCH_RESULT_BYTES,
  measureMcpResearchResultBytes,
  ResearchResultTooLargeError,
} from "./report-renderer.js";
import type { ResearchRepositories, ResearchIdKind } from "./repositories.js";
import { createResearchRepositories } from "./repositories.js";
import { initSchema } from "../scripts/lib/schema.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
});

interface Harness {
  db: Database.Database;
  repositories: ResearchRepositories;
  runId: string;
  hypothesisId: string;
  queryId: string;
  lease: ReturnType<ResearchRepositories["leases"]["acquire"]>;
}

function makeHarness(workspaceKey = "report-workspace"): Harness {
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
      targetUser: "Small volunteer teams.",
      problem: "A recurring handoff requires manual follow-up.",
      proposedSolution: "A focused handoff helper.",
    },
    hypotheses: [{ claim: "Small volunteer teams repeat a manual handoff each week." }],
  });
  const hypothesisId = created.hypothesisRevisions[0].hypothesisId;
  const plan = repositories.plans.create({
    caseId: created.caseId,
    caseRevision: created.revision,
    queries: [
      { text: "Synthetic handoff stories", purpose: "problem_language", evidenceIntent: "supporting", hypothesisIds: [hypothesisId], sourceScopes: ["public_web"] },
      { text: "Synthetic handoff counterexamples", purpose: "counterevidence", evidenceIntent: "challenging", hypothesisIds: [hypothesisId], sourceScopes: ["public_web"] },
    ],
    limits: { maxQueries: 2, maxFetchedPages: 4, maxFollowUpRounds: 1, maxWallTimeSeconds: 60, maxModelInputTokens: 2_000, maxModelOutputTokens: 1_000 },
  });
  const run = repositories.runs.create({ caseId: created.caseId, caseRevision: created.revision, planId: plan.planId });
  const lease = repositories.leases.acquire({ runId: run.runId, ownerInstanceId: `${workspaceKey}-worker`, ttlMilliseconds: 60_000 });
  return { db, repositories, runId: run.runId, hypothesisId, queryId: plan.queries[0].queryId, lease };
}

function addSnippet(harness: Harness, snippetId: string, text: string, sourceUrl = "https://example.com/synthetic-snippet"): void {
  harness.repositories.evidence.save(harness.runId, {
    kind: "search_snippet",
    snippetId,
    queryId: harness.queryId,
    sourceUrl,
    text,
    assessmentEligible: false,
  }, harness.lease);
}

function assessment(harness: Harness, coverageGaps: ResearchAssessment["coverageGaps"] = []): ResearchAssessment {
  return {
    outcome: "insufficient_evidence",
    summary: "Synthetic evidence is limited.",
    rationale: "Caller-provided alternatives are unverified context.",
    claims: [{
      hypothesisId: harness.hypothesisId,
      outcome: "insufficient_evidence",
      rationale: "No direct verified excerpt is available.",
      supportingEvidenceIds: [],
      challengingEvidenceIds: [],
      missingEvidence: ["A verified original that directly addresses the claim."],
    }],
    coverageGaps,
    nextExperiment: "Interview a few synthetic target users and record counterexamples.",
  };
}

function addManySnippets(harness: Harness, count: number, text: string, sourceUrl = "https://example.com/synthetic-snippet"): void {
  for (let index = 0; index < count; index += 1) addSnippet(harness, `snippet-${index.toString().padStart(3, "0")}`, text, sourceUrl);
}

describe("research result service and Markdown renderer", () => {
  it("paginates the complete evidence set under the duplicated MCP byte budget", () => {
    const harness = makeHarness();
    const longSyntheticUrl = `https://example.com/${"x".repeat(2_028)}`;
    addManySnippets(harness, 105, "Synthetic discovery text ".repeat(80), longSyntheticUrl);
    const service = createResearchResultService(harness.repositories);
    const received: string[] = [];
    let page = service.result({ runId: harness.runId, limit: 100 });
    expect(page.evidence.length).toBeGreaterThan(0);
    expect(page.evidence.length).toBeLessThan(100);
    expect(page.pagination.totalEvidence).toBe(105);
    while (true) {
      expect(measureMcpResearchResultBytes(page)).toBeLessThanOrEqual(MAX_RESEARCH_RESULT_BYTES);
      expect(page.reportMarkdown).toBeNull();
      received.push(...page.evidence.map((item) => item.kind === "search_snippet" ? item.snippetId : item.evidenceId));
      if (!page.pagination.hasMore) break;
      expect(page.pagination.nextCursor).toBeTruthy();
      page = service.result({ runId: harness.runId, cursor: page.pagination.nextCursor! });
    }
    expect(received).toHaveLength(105);
    expect(new Set(received).size).toBe(105);
    expect(received).toEqual([...received].sort());
  });

  it("keeps Unicode Markdown pages byte-bounded and renders only the evidence on each page", () => {
    const harness = makeHarness("report-unicode-markdown");
    addManySnippets(harness, 105, "🧪é — ".repeat(250));
    const service = createResearchResultService(harness.repositories);
    const received: string[] = [];
    const renderedPages: string[] = [];
    let page = service.result({ runId: harness.runId, limit: 100, format: "markdown" });

    while (true) {
      expect(page.reportMarkdown).not.toBeNull();
      expect(page.reportMarkdown!.length).toBeLessThanOrEqual(30_000);
      expect(measureMcpResearchResultBytes(page)).toBeLessThanOrEqual(MAX_RESEARCH_RESULT_BYTES);
      const currentIds = page.evidence.map((item) => item.kind === "search_snippet" ? item.snippetId : item.evidenceId);
      for (const id of currentIds) {
        expect(page.reportMarkdown).toContain(`### Discovery snippet ${id.replaceAll("-", "\\-")} (not assessment evidence)`);
      }
      for (const priorId of received) {
        expect(page.reportMarkdown).not.toContain(`### Discovery snippet ${priorId.replaceAll("-", "\\-")} (not assessment evidence)`);
      }
      received.push(...currentIds);
      renderedPages.push(page.reportMarkdown!);
      if (!page.pagination.hasMore) break;
      page = service.result({ runId: harness.runId, cursor: page.pagination.nextCursor!, format: "markdown" });
    }

    expect(renderedPages.length).toBeGreaterThan(1);
    expect(renderedPages[0]).toContain("🧪é");
    expect(received).toHaveLength(105);
    expect(new Set(received).size).toBe(105);
  });

  it("binds opaque cursors to the run, page size, and complete result content", () => {
    const harness = makeHarness();
    addManySnippets(harness, 3, "Synthetic discovery text.");
    const service = createResearchResultService(harness.repositories);
    const first = service.result({ runId: harness.runId, limit: 1 });
    const cursor = first.pagination.nextCursor!;
    expect(cursor).toMatch(/^r1\./);
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(() => service.result({ runId: harness.runId, cursor, limit: 2 }))
      .toThrow(InvalidResearchResultCursorError);

    addSnippet(harness, "snippet-new-after-first-page", "Synthetic evidence changed after cursor issuance.");
    try {
      service.result({ runId: harness.runId, cursor });
      throw new Error("Expected changed result content to invalidate the cursor.");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidResearchResultCursorError);
      expect(error).toMatchObject({ reason: "stale" });
    }

    const secondRun = harness.repositories.runs.create({
      caseId: harness.repositories.runs.get(harness.runId)!.caseId,
      caseRevision: harness.repositories.runs.get(harness.runId)!.caseRevision,
      planId: harness.repositories.runs.get(harness.runId)!.planId,
    });
    expect(() => service.result({ runId: secondRun.runId, cursor }))
      .toThrow(InvalidResearchResultCursorError);
  });

  it("renders Markdown from the same page and labels snippets as discovery only", () => {
    const harness = makeHarness();
    addSnippet(harness, "snippet-markdown", "<script>alert('synthetic')</script> [untrusted](javascript:bad)");
    harness.repositories.assessments.save(harness.runId, assessment(harness), harness.lease);
    const service = createResearchResultService(harness.repositories);
    const page = service.result({ runId: harness.runId, format: "markdown" });

    expect(page.reportMarkdown).toContain("Caller\\-provided alternatives are unverified context");
    expect(page.reportMarkdown).toContain("Discovery snippet snippet\\-markdown (not assessment evidence)");
    expect(page.reportMarkdown).toContain("This snippet is a retrieval lead only.");
    expect(page.reportMarkdown).toContain("&lt;script&gt;");
    expect(page.reportMarkdown).not.toContain("<script>");
    expect(page.reportMarkdown).not.toContain("[untrusted](javascript:bad)");
    expect(page.reportMarkdown!.length).toBeLessThanOrEqual(30_000);
    expect(measureMcpResearchResultBytes(page)).toBeLessThanOrEqual(MAX_RESEARCH_RESULT_BYTES);
  });

  it("rejects out-of-schema assessment text and claim counts without truncating them", () => {
    const harness = makeHarness();
    const valid = assessment(harness);
    const oversizedText = { ...valid, summary: "S".repeat(2_001) };
    const oversizedClaims = { ...valid, claims: Array.from({ length: 21 }, () => valid.claims[0]) };

    for (const value of [oversizedText, oversizedClaims]) {
      const repositories = {
        ...harness.repositories,
        assessments: {
          ...harness.repositories.assessments,
          get: () => value,
        },
      } as ResearchRepositories;
      expect(() => createResearchResultService(repositories).result({ runId: harness.runId }))
        .toThrow(ResearchResultTooLargeError);
    }
  });

  it("fails safely when repeated assessment content alone cannot fit instead of dropping it", () => {
    const harness = makeHarness();
    const longDetail = "Synthetic gap detail ".repeat(40);
    const tooLarge = assessment(harness, Array.from({ length: 1_000 }, (_, index) => ({
      reason: "no_results" as const,
      detail: `${index.toString().padStart(4, "0")} ${longDetail}`,
      queryId: null,
      hypothesisId: null,
    })));
    harness.repositories.assessments.save(harness.runId, tooLarge, harness.lease);
    const service = createResearchResultService(harness.repositories);

    expect(() => service.result({ runId: harness.runId })).toThrow(ResearchResultTooLargeError);
  });
});
