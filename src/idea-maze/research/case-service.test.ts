import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResearchLimits } from "./contracts.js";
import { createResearchContext, type ResearchContext } from "./context.js";
import { createResearchRepositories, type ResearchRepositories } from "./repositories.js";
import { createResearchCaseService, type ResearchCaseApplication } from "./case-service.js";
import { noResearchProviders } from "./ports.js";
import { initSchema } from "../scripts/lib/schema.js";

const TEST_LIMITS: ResearchLimits = {
  maxQueries: 8,
  maxFetchedPages: 12,
  maxFollowUpRounds: 1,
  maxWallTimeSeconds: 120,
  maxModelInputTokens: 4_000,
  maxModelOutputTokens: 2_000,
};

interface Harness {
  db: Database.Database;
  context: ResearchContext;
  repositories: ResearchRepositories;
  service: ResearchCaseApplication;
  advance(milliseconds: number): void;
}

const contexts: ResearchContext[] = [];
const databases: Database.Database[] = [];
const roots: string[] = [];

function makeHarness(workspaceKey = "workspace-a", sharedDb?: Database.Database): Harness {
  const root = mkdtempSync(join(tmpdir(), "research-case-service-"));
  roots.push(root);
  const db = sharedDb ?? new Database(":memory:");
  if (!sharedDb) databases.push(db);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  initSchema(db);

  let currentTime = Date.parse("2026-01-02T03:04:05.000Z");
  const ids = new Map<string, number>();
  const lifetime = new AbortController();
  const context = createResearchContext({
    database: { ownership: "borrowed", connection: db },
    paths: { workspaceRoot: root, databaseFile: null },
    workspaceKey,
    clock: { now: () => new Date(currentTime) },
    logger: { log: vi.fn() },
    providers: noResearchProviders(),
    serviceLifetimeSignal: lifetime.signal,
    limits: TEST_LIMITS,
    idFactory: (kind) => {
      const next = (ids.get(kind) ?? 0) + 1;
      ids.set(kind, next);
      return `${workspaceKey}-${kind}-${next}`;
    },
  });
  contexts.push(context);
  const repositories = createResearchRepositories({
    db: context.db,
    workspaceKey: context.workspaceKey,
    clock: () => context.clock.now(),
    idFactory: context.idFactory,
  });
  return {
    db,
    context,
    repositories,
    service: createResearchCaseService(context, repositories),
    advance(milliseconds) { currentTime += milliseconds; },
  };
}

function readyIntake() {
  return {
    ideaSummary: "A helper for a recurring team workflow.",
    targetUser: "Small operations teams.",
    problem: "A repeated manual workflow takes too much time.",
    proposedSolution: "A focused workflow helper.",
  };
}

function hypothesisClaim(index = 1) {
  return `Small teams repeat a manual workflow each week, claim ${index}.`;
}

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose();
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("research case service", () => {
  it("creates incomplete drafts, replays writes, preserves provenance, and keeps old run snapshots fixed", async () => {
    const harness = makeHarness();
    const suggestion = harness.repositories.suggestions.create("Teams may rely on a shared spreadsheet.");
    const input = {
      idempotencyKey: "create-case-key-001",
      intake: { ideaSummary: "A synthetic idea." },
      hypotheses: [
        { claim: "Small teams repeat a manual task each week." },
        { claim: suggestion.claim, origin: "model_suggested" as const, sourceSuggestionId: suggestion.suggestionId },
      ],
    };

    const created = await harness.service.createCase(input);
    expect(created.schemaVersion).toBe("1.0.0");
    expect("error" in created).toBe(false);
    if ("error" in created) return;
    const firstCase = created.data.case;
    expect(firstCase.status).toBe("draft");
    expect(firstCase.missingFields.filter((item) => item.blockingForPlanning).map((item) => item.field))
      .toEqual(["targetUser", "problem", "proposedSolution"]);
    expect(firstCase.hypotheses[1]).toMatchObject({
      origin: "model_suggested",
      sourceSuggestionId: suggestion.suggestionId,
    });
    expect(firstCase.hypotheses[0].origin).toBe("user_supplied");

    harness.advance(30_000);
    expect(await harness.service.createCase(input)).toEqual(created);
    const mismatchedReplay = await harness.service.createCase({
      ...input,
      intake: { ideaSummary: "A different synthetic idea." },
    });
    expect(mismatchedReplay).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });

    const revised = await harness.service.updateCase({
      idempotencyKey: "update-case-key-001",
      caseId: firstCase.caseId,
      expectedRevision: 1,
      intakePatch: readyIntake(),
      hypothesisMutations: [{
        operation: "revise",
        hypothesisId: firstCase.hypotheses[1].hypothesisId,
        expectedRevision: 1,
        claim: "Teams may use shared spreadsheets to coordinate this workflow.",
      }],
    });
    expect("error" in revised).toBe(false);
    if ("error" in revised) return;
    expect(revised.data.case.status).toBe("ready");
    expect(revised.data.case.createdAt).toBe(firstCase.createdAt);
    expect(revised.data.case.updatedAt).not.toBe(firstCase.updatedAt);
    expect(revised.data.case.hypotheses[1]).toMatchObject({
      revision: 2,
      origin: "model_suggested",
      sourceSuggestionId: suggestion.suggestionId,
    });

    const historical = await harness.service.getCase({ caseId: firstCase.caseId, revision: 1 });
    expect("error" in historical).toBe(false);
    if ("error" in historical) return;
    expect(historical.data).toEqual(firstCase);

    const accepted = revised.data.case;
    const activeHypothesis = accepted.hypotheses.find((item) => item.state === "active");
    expect(activeHypothesis).toBeDefined();
    const plan = harness.repositories.plans.create({
      caseId: accepted.caseId,
      caseRevision: accepted.revision,
      queries: [
        {
          text: "How do small teams handle this recurring workflow?",
          purpose: "problem_language",
          evidenceIntent: "supporting",
          hypothesisIds: [activeHypothesis!.hypothesisId],
          sourceScopes: ["public_web"],
        },
        {
          text: "What evidence suggests teams do not need workflow help?",
          purpose: "counterevidence",
          evidenceIntent: "challenging",
          hypothesisIds: [activeHypothesis!.hypothesisId],
          sourceScopes: ["community_discussions"],
        },
      ],
      limits: {
        maxQueries: 2,
        maxFetchedPages: 2,
        maxFollowUpRounds: 0,
        maxWallTimeSeconds: 30,
        maxModelInputTokens: 1_000,
        maxModelOutputTokens: 1_000,
      },
    });
    const run = harness.repositories.runs.create({
      caseId: accepted.caseId,
      caseRevision: accepted.revision,
      planId: plan.planId,
    });

    harness.advance(30_000);
    await harness.service.updateCase({
      idempotencyKey: "update-case-key-002",
      caseId: accepted.caseId,
      expectedRevision: accepted.revision,
      intakePatch: { decisionMaker: "An operations lead." },
    });
    expect(harness.repositories.runs.get(run.runId)?.snapshot.caseRevision).toEqual(
      harness.repositories.cases.get(accepted.caseId, accepted.revision),
    );
    expect(harness.db.open).toBe(true);
  });

  it("returns stale revision conflicts and rolls back earlier mutations in the same request", async () => {
    const harness = makeHarness();
    const created = await harness.service.createCase({
      idempotencyKey: "create-stale-key-001",
      intake: readyIntake(),
      hypotheses: [{ claim: hypothesisClaim() }],
    });
    if ("error" in created) throw new Error("case creation should succeed");
    const original = created.data.case;
    const hypothesisId = original.hypotheses[0].hypothesisId;

    const firstRevision = await harness.service.updateCase({
      idempotencyKey: "update-stale-key-001",
      caseId: original.caseId,
      expectedRevision: 1,
      hypothesisMutations: [{ operation: "revise", hypothesisId, expectedRevision: 1, claim: hypothesisClaim(2) }],
    });
    expect("error" in firstRevision).toBe(false);

    const staleCase = await harness.service.updateCase({
      idempotencyKey: "update-stale-key-002",
      caseId: original.caseId,
      expectedRevision: 1,
      intakePatch: { decisionMaker: "This stale write must not persist." },
      hypothesisMutations: [{ operation: "add", clientRef: "stale-new", claim: hypothesisClaim(3) }],
    });
    expect(staleCase).toMatchObject({ error: { code: "REVISION_CONFLICT", details: { kind: "revision_conflict", currentRevision: 2 } } });

    const staleHypothesis = await harness.service.updateCase({
      idempotencyKey: "update-stale-key-003",
      caseId: original.caseId,
      expectedRevision: 2,
      hypothesisMutations: [
        { operation: "add", clientRef: "rollback-add", claim: hypothesisClaim(4) },
        { operation: "retire", hypothesisId, expectedRevision: 1 },
      ],
    });
    expect(staleHypothesis).toMatchObject({ error: { code: "REVISION_CONFLICT", details: { kind: "hypothesis_revision_conflict" } } });

    const latest = await harness.service.getCase({ caseId: original.caseId });
    expect("error" in latest).toBe(false);
    if ("error" in latest) return;
    expect(latest.data.revision).toBe(2);
    expect(latest.data.hypotheses).toHaveLength(1);
    expect(latest.data.intake.decisionMaker).toBeUndefined();
    expect(latest.data.hypotheses[0].revision).toBe(2);
  });

  it("enforces the output hypothesis cap and rejects IDs from another workspace", async () => {
    const db = new Database(":memory:");
    databases.push(db);
    const workspaceA = makeHarness("workspace-a", db);
    const workspaceB = makeHarness("workspace-b", db);
    const created = await workspaceA.service.createCase({
      idempotencyKey: "create-capped-key-001",
      hypotheses: Array.from({ length: 20 }, (_, index) => ({ claim: hypothesisClaim(index + 1) })),
    });
    if ("error" in created) throw new Error("case creation should succeed");
    expect(created.data.case.intake).toEqual({});
    expect(created.data.case.status).toBe("draft");
    const retired = await workspaceA.service.updateCase({
      idempotencyKey: "update-capped-key-001",
      caseId: created.data.case.caseId,
      expectedRevision: 1,
      hypothesisMutations: [{
        operation: "retire",
        hypothesisId: created.data.case.hypotheses[0].hypothesisId,
        expectedRevision: 1,
      }],
    });
    if ("error" in retired) throw new Error("hypothesis retirement should succeed");

    const overflow = await workspaceA.service.updateCase({
      idempotencyKey: "update-capped-key-002",
      caseId: created.data.case.caseId,
      expectedRevision: 2,
      hypothesisMutations: [{ operation: "add", clientRef: "overflow", claim: hypothesisClaim(21) }],
    });
    expect(overflow).toMatchObject({
      schemaVersion: "1.0.0",
      error: { code: "VALIDATION_ERROR", details: { kind: "validation", issues: [{ path: "hypothesisMutations", code: "out_of_range" }] } },
    });

    const hiddenCase = await workspaceB.service.getCase({ caseId: created.data.case.caseId });
    expect(hiddenCase).toMatchObject({ error: { code: "NOT_FOUND", details: { resource: "case" } } });
    const suggestion = workspaceA.repositories.suggestions.create("A workspace-bound suggested claim.");
    const invalidSuggestion = await workspaceB.service.createCase({
      idempotencyKey: "create-foreign-suggestion-001",
      hypotheses: [{ claim: suggestion.claim, origin: "model_suggested", sourceSuggestionId: suggestion.suggestionId }],
    });
    expect(invalidSuggestion).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { issues: [{ path: "hypotheses[0].sourceSuggestionId", code: "invalid_value" }] } },
    });

    const afterOverflow = await workspaceA.service.getCase({ caseId: created.data.case.caseId });
    expect("error" in afterOverflow).toBe(false);
    if (!("error" in afterOverflow)) {
      expect(afterOverflow.data.hypotheses).toHaveLength(20);
      expect(afterOverflow.data.hypotheses.some((hypothesis) => hypothesis.state === "retired")).toBe(true);
    }
  });

  it("validates malformed inputs and hides internal exception text", async () => {
    const harness = makeHarness();
    const malformed = await harness.service.createCase({
      idempotencyKey: "malformed-case-key-001",
      ["private-secret-sentinel"]: "must not be reflected",
    } as never);
    expect(malformed).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { issues: [{ path: "*", code: "unknown_key" }] } },
    });
    expect(JSON.stringify(malformed)).not.toContain("private-secret-sentinel");

    harness.db.close();
    const internal = await harness.service.getCase({ caseId: "valid-case-id" });
    expect(internal).toMatchObject({
      schemaVersion: "1.0.0",
      error: { code: "INTERNAL_ERROR", message: "The research request could not be completed.", details: { kind: "internal" } },
    });
    expect(JSON.stringify(internal)).not.toMatch(/SQLITE|closed|database|\/private\//iu);
  });

  it("rejects every case operation after shutdown without using or closing a borrowed database", async () => {
    const harness = makeHarness();
    const created = await harness.service.createCase({
      idempotencyKey: "create-lifetime-key-001",
      intake: readyIntake(),
      hypotheses: [{ claim: hypothesisClaim() }],
    });
    if ("error" in created) throw new Error("case creation should succeed before shutdown");
    const caseId = created.data.case.caseId;
    const counts = () => harness.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM research_cases WHERE workspace_key = ?) AS cases,
        (SELECT COUNT(*) FROM research_case_revisions WHERE workspace_key = ?) AS revisions,
        (SELECT COUNT(*) FROM research_idempotency_receipts WHERE workspace_key = ?) AS receipts
    `).get("workspace-a", "workspace-a", "workspace-a");
    const before = counts();

    const createSpy = vi.spyOn(harness.repositories.cases, "create");
    const getSpy = vi.spyOn(harness.repositories.cases, "get");
    const updateSpy = vi.spyOn(harness.repositories.cases, "update");
    const idempotencySpy = vi.spyOn(harness.repositories.idempotency, "execute");
    const expectStopped = async () => {
      const createResult = await harness.service.createCase({
        idempotencyKey: "create-after-shutdown-001",
        intake: readyIntake(),
      });
      const getResult = await harness.service.getCase({ caseId });
      const updateResult = await harness.service.updateCase({
        idempotencyKey: "update-after-shutdown-001",
        caseId,
        expectedRevision: 1,
        intakePatch: { decisionMaker: "A later decision maker." },
      });
      for (const response of [createResult, getResult, updateResult]) {
        expect(response).toMatchObject({
          schemaVersion: "1.0.0",
          error: {
            code: "INTERNAL_ERROR",
            message: "The research service is not active.",
            retryable: false,
            details: { kind: "internal" },
          },
        });
      }
    };

    harness.context.shutdown();
    await expectStopped();
    harness.context.dispose();
    await expectStopped();

    expect(createSpy).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(idempotencySpy).not.toHaveBeenCalled();
    expect(counts()).toEqual(before);
    expect(harness.db.open).toBe(true);
  });
});
