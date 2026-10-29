import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelProvider, ResearchProviderBindings, SafeLogEntry } from "./ports.js";
import { noResearchProviders, ResearchProviderError } from "./ports.js";
import type { ResearchLimits } from "./contracts.js";
import { createResearchContext, type ResearchContext } from "./context.js";
import { createResearchRepositories, type ResearchIdKind, type ResearchRepositories } from "./repositories.js";
import { createResearchCaseService, type ResearchCaseApplication } from "./case-service.js";
import { createResearchPlanner, type ResearchPlannerApplication } from "./planner.js";
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
  cases: ResearchCaseApplication;
  planner: ResearchPlannerApplication;
  advance(milliseconds: number): void;
  shutdown(): void;
}

const contexts: ResearchContext[] = [];
const databases: Database.Database[] = [];
const roots: string[] = [];
let caseCreateSerial = 0;

function makeHarness(options: {
  workspaceKey?: string;
  root?: string;
  filename?: string;
  limits?: ResearchLimits;
  model?: ModelProvider;
  idPrefix?: string;
  onLog?: (entry: Readonly<SafeLogEntry>) => void;
} = {}): Harness {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "research-planner-"));
  if (!options.root) roots.push(root);
  const db = new Database(options.filename ?? ":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  initSchema(db);

  let currentTime = Date.parse("2026-01-02T03:04:05.000Z");
  const ids = new Map<string, number>();
  const lifetime = new AbortController();
  const providers: ResearchProviderBindings = noResearchProviders();
  if (options.model) {
    providers.model = { availability: "available", adapter: "mock-model", provider: options.model };
  }
  const workspaceKey = options.workspaceKey ?? "planner-workspace";
  const prefix = options.idPrefix ?? workspaceKey;
  const context = createResearchContext({
    database: { ownership: "borrowed", connection: db },
    paths: { workspaceRoot: root, databaseFile: null },
    workspaceKey,
    clock: { now: () => new Date(currentTime) },
    logger: { log: (entry) => options.onLog?.(entry) },
    providers,
    serviceLifetimeSignal: lifetime.signal,
    limits: options.limits ?? TEST_LIMITS,
    idFactory: (kind: ResearchIdKind) => {
      const next = (ids.get(kind) ?? 0) + 1;
      ids.set(kind, next);
      return `${prefix}-${kind}-${next}`;
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
    cases: createResearchCaseService(context, repositories),
    planner: createResearchPlanner(context, repositories),
    advance(milliseconds) { currentTime += milliseconds; },
    shutdown() { lifetime.abort(); },
  };
}

function readyIntake() {
  return {
    ideaSummary: "PRIVATE_COMPLETE_IDEA_SENTINEL_FOR_QUERY_TESTS",
    targetUser: "Small operations teams",
    problem: "A repeated manual reconciliation workflow takes too much time each week.",
    proposedSolution: "A focused workflow helper",
  };
}

async function createReadyCase(harness: Harness, claims = ["Small teams repeat a manual reconciliation workflow each week."]) {
  const response = await harness.cases.createCase({
    idempotencyKey: `create-planner-case-${++caseCreateSerial}`,
    intake: readyIntake(),
    hypotheses: claims.map((claim) => ({ claim })),
  });
  if ("error" in response) throw new Error("Synthetic case creation should succeed");
  return response.data.case;
}

function planDraft(hypothesisIds: string[], limits: ResearchLimits = {
  maxQueries: 2,
  maxFetchedPages: 3,
  maxFollowUpRounds: 0,
  maxWallTimeSeconds: 30,
  maxModelInputTokens: 1_000,
  maxModelOutputTokens: 500,
}) {
  const queries = hypothesisIds.flatMap((hypothesisId) => [
    {
      text: `What language describes this problem for ${hypothesisId}?`,
      purpose: "problem_language" as const,
      evidenceIntent: "supporting" as const,
      hypothesisIds: [hypothesisId],
      sourceScopes: ["public_web" as const],
    },
    {
      text: `What evidence challenges this problem for ${hypothesisId}?`,
      purpose: "counterevidence" as const,
      evidenceIntent: "challenging" as const,
      hypothesisIds: [hypothesisId],
      sourceScopes: ["community_discussions" as const],
    },
  ]);
  return { queries, limits: { ...limits, maxQueries: Math.max(limits.maxQueries, queries.length) } };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockModel(
  generate: (signal: AbortSignal) => Promise<unknown> = async () => ({
    claims: ["Small teams may copy reconciliation results between tools."],
  }),
) {
  const provider: ModelProvider = {
    async generateJson<T>(request) {
      const value = await generate(request.signal);
      return {
        value: value as T,
        usage: { inputTokens: 120, outputTokens: 40, costMicros: null },
      };
    },
  };
  return provider;
}

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  caseCreateSerial = 0;
  vi.restoreAllMocks();
});

describe("bounded research planner", () => {
  it("generates balanced, purpose-diverse queries and exposes exact bounded outbound text", async () => {
    const harness = makeHarness();
    const created = await createReadyCase(harness);
    const response = await harness.planner.plan({
      idempotencyKey: "generated-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
    });

    expect("error" in response).toBe(false);
    if ("error" in response) return;
    expect(response.data.status).toBe("ready");
    const plan = response.data.plan;
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.queries).toHaveLength(4);
    expect(new Set(plan.queries.map((query) => query.purpose))).toEqual(
      new Set(["problem_language", "workaround", "alternative", "counterevidence"]),
    );
    expect(plan.queries.every((query) => query.text.length <= 240)).toBe(true);
    expect(plan.queries.some((query) => query.text.includes("site:reddit.com"))).toBe(true);
    expect(plan.queries.map((query) => query.text).join(" ")).not.toContain("PRIVATE_COMPLETE_IDEA_SENTINEL_FOR_QUERY_TESTS");
    expect(plan.queries.find((query) => query.purpose === "problem_language")?.text).toContain("reconciliation");
    expect(plan.queries.every((query) => query.hypothesisIds.includes(created.hypotheses[0].hypothesisId))).toBe(true);
    expect(plan.queries.some((query) => query.evidenceIntent === "supporting")).toBe(true);
    expect(plan.queries.some((query) => query.evidenceIntent === "challenging")).toBe(true);
    expect(plan.queries.find((query) => query.purpose === "counterevidence")?.evidenceIntent).toBe("challenging");
    expect(response.data.missingFields.map((field) => field.field)).toEqual([
      "currentAlternatives", "usageFrequency", "budgetOrWillingnessToPay", "decisionMaker", "constraints",
    ]);
  });

  it("merges semantically duplicate generated queries while retaining every hypothesis mapping", async () => {
    const harness = makeHarness();
    const repeatedClaim = "Small teams repeat a manual reconciliation workflow each week.";
    const created = await createReadyCase(harness, [repeatedClaim, repeatedClaim, repeatedClaim, repeatedClaim]);
    const response = await harness.planner.plan({
      idempotencyKey: "merged-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
    });
    expect("error" in response).toBe(false);
    if ("error" in response) return;
    const queries = response.data.plan?.queries ?? [];
    expect(queries).toHaveLength(4);
    expect(queries.every((query) => query.hypothesisIds.length === 2)).toBe(true);
    expect(queries.every((query) => !/hypothesis\s+\d+/i.test(query.text))).toBe(true);
    for (const hypothesis of created.hypotheses) {
      const mapped = queries.filter((query) => query.hypothesisIds.includes(hypothesis.hypothesisId));
      expect(mapped.some((query) => query.evidenceIntent === "supporting")).toBe(true);
      expect(mapped.some((query) => query.evidenceIntent === "challenging")).toBe(true);
    }
  });

  it("validates and saves a supplied plan offline without contacting any model provider", async () => {
    const generate = vi.fn(async () => ({ claims: ["Should never be requested."] }));
    const harness = makeHarness({ model: mockModel(generate) });
    const created = await createReadyCase(harness);
    const suppliedPlan = planDraft([created.hypotheses[0].hypothesisId]);
    suppliedPlan.queries[0].text = "What exact wording do teams use for reconciliation pain?";

    const response = await harness.planner.plan({
      idempotencyKey: "supplied-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      suppliedPlan,
    });

    expect("error" in response).toBe(false);
    if ("error" in response) return;
    expect(response.data.status).toBe("ready");
    expect(response.data.plan?.queries[0].text).toBe(suppliedPlan.queries[0].text);
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns exact intake clarification fields and never fills buyer, budget, or frequency", async () => {
    const generate = vi.fn(async () => ({ claims: ["Should not infer a hypothesis yet."] }));
    const harness = makeHarness({ model: mockModel(generate) });
    const created = await harness.cases.createCase({
      idempotencyKey: "incomplete-case-key-001",
      intake: { ideaSummary: "A synthetic project idea." },
    });
    if ("error" in created) throw new Error("Synthetic incomplete case creation should succeed");

    const response = await harness.planner.plan({
      idempotencyKey: "incomplete-plan-key-001",
      caseId: created.data.case.caseId,
      expectedCaseRevision: created.data.case.revision,
      requestHypothesisSuggestions: true,
    });
    expect("error" in response).toBe(false);
    if ("error" in response) return;
    expect(response.data.status).toBe("needs_clarification");
    expect(response.data.plan).toBeNull();
    expect(response.data.missingFields.map((field) => field.field)).toEqual([
      "targetUser", "problem", "proposedSolution", "currentAlternatives", "usageFrequency",
      "budgetOrWillingnessToPay", "decisionMaker", "constraints", "hypotheses",
    ]);
    expect(response.data.missingFields.find((field) => field.field === "budgetOrWillingnessToPay")?.clarification)
      .toMatch(/budget|willingness/i);
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns model claims as unaccepted suggestions without changing a case that has no active hypotheses", async () => {
    const harness = makeHarness({ model: mockModel(async () => ({
      claims: ["Small teams may repeat reconciliation work every week."],
    })) });
    const created = await harness.cases.createCase({
      idempotencyKey: "no-hypothesis-case-key-001",
      intake: readyIntake(),
    });
    if ("error" in created) throw new Error("Synthetic case creation should succeed");
    const before = created.data.case;

    const response = await harness.planner.plan({
      idempotencyKey: "suggestion-only-plan-key-001",
      caseId: before.caseId,
      expectedCaseRevision: before.revision,
      requestHypothesisSuggestions: true,
    });

    expect("error" in response).toBe(false);
    if ("error" in response) return;
    expect(response.data.status).toBe("needs_clarification");
    expect(response.data.plan).toBeNull();
    expect(response.data.missingFields.map((field) => field.field)).toEqual([
      "currentAlternatives", "usageFrequency", "budgetOrWillingnessToPay", "decisionMaker", "constraints", "hypotheses",
    ]);
    expect(response.data.hypothesisSuggestions).toHaveLength(1);
    expect(response.data.hypothesisSuggestions[0]).toMatchObject({
      origin: "model_suggested",
      status: "unaccepted_suggestion",
    });
    const after = harness.repositories.cases.get(before.caseId);
    expect(after).toEqual({
      caseId: before.caseId,
      revision: before.revision,
      intake: before.intake,
      hypothesisRevisions: [],
      createdAt: before.createdAt,
    });
  });

  it("rejects context-excessive and hard-ceiling supplied budgets plus stale revisions", async () => {
    const harness = makeHarness();
    const created = await createReadyCase(harness);
    const excessiveContextPlan = planDraft([created.hypotheses[0].hypothesisId], {
      maxQueries: 2,
      maxFetchedPages: 13,
      maxFollowUpRounds: 0,
      maxWallTimeSeconds: 30,
      maxModelInputTokens: 1_000,
      maxModelOutputTokens: 500,
    });
    const overContext = await harness.planner.plan({
      idempotencyKey: "budget-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      suppliedPlan: excessiveContextPlan,
    });
    expect(overContext).toMatchObject({
      error: { code: "LIMIT_EXCEEDED", details: { kind: "limit_exceeded", limitName: "maxFetchedPages", limit: 12, requested: 13 } },
    });

    const excessiveHardPlan = planDraft([created.hypotheses[0].hypothesisId], {
      maxQueries: 2,
      maxFetchedPages: 3,
      maxFollowUpRounds: 0,
      maxWallTimeSeconds: 30,
      maxModelInputTokens: 20_001,
      maxModelOutputTokens: 500,
    });
    const overHard = await harness.planner.plan({
      idempotencyKey: "hard-budget-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      suppliedPlan: excessiveHardPlan,
    });
    expect(overHard).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    await harness.cases.updateCase({
      idempotencyKey: "revise-case-for-stale-plan-001",
      caseId: created.caseId,
      expectedRevision: created.revision,
      intakePatch: { decisionMaker: "A team lead." },
    });
    const stale = await harness.planner.plan({
      idempotencyKey: "stale-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
    });
    expect(stale).toMatchObject({
      error: { code: "REVISION_CONFLICT", details: { kind: "revision_conflict", expectedRevision: 1, currentRevision: 2 } },
    });
  });

  it("rejects generated plans when context query limits cannot keep balanced coverage", async () => {
    const harness = makeHarness({ limits: { ...TEST_LIMITS, maxQueries: 3 } });
    const created = await createReadyCase(harness);
    const response = await harness.planner.plan({
      idempotencyKey: "too-small-query-budget-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
    });
    expect(response).toMatchObject({
      error: { code: "LIMIT_EXCEEDED", details: { kind: "limit_exceeded", limitName: "maxQueries", limit: 3, requested: 4 } },
    });
  });

  it("rejects foreign and retired hypotheses in supplied plans", async () => {
    const harness = makeHarness();
    const first = await createReadyCase(harness, [
      "Small teams repeat a manual reconciliation workflow each week.",
      "Teams may use shared spreadsheets to reconcile records.",
    ]);
    const second = await createReadyCase(harness);
    const retiredId = first.hypotheses[1].hypothesisId;
    const retired = await harness.cases.updateCase({
      idempotencyKey: "retire-hypothesis-key-001",
      caseId: first.caseId,
      expectedRevision: first.revision,
      hypothesisMutations: [{ operation: "retire", hypothesisId: retiredId, expectedRevision: 1 }],
    });
    if ("error" in retired) throw new Error("Synthetic hypothesis retirement should succeed");

    for (const [index, target] of [
      { caseId: first.caseId, revision: retired.data.case.revision, hypothesisId: retiredId },
      { caseId: first.caseId, revision: retired.data.case.revision, hypothesisId: second.hypotheses[0].hypothesisId },
    ].entries()) {
      const response = await harness.planner.plan({
        idempotencyKey: `invalid-hypothesis-plan-${index}`,
        caseId: target.caseId,
        expectedCaseRevision: target.revision,
        suppliedPlan: planDraft([target.hypothesisId]),
      });
      expect(response).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
  });

  it("reserves model work across SQLite connections so identical concurrent requests invoke the provider once", async () => {
    const root = mkdtempSync(join(tmpdir(), "research-planner-concurrent-"));
    roots.push(root);
    const filename = join(root, "research.sqlite");
    const started = deferred<void>();
    const release = deferred<unknown>();
    let calls = 0;
    const provider = mockModel(async () => {
      calls += 1;
      started.resolve();
      return release.promise;
    });
    const leader = makeHarness({ root, filename, workspaceKey: "shared-planner-workspace", model: provider, idPrefix: "leader" });
    const follower = makeHarness({ root, filename, workspaceKey: "shared-planner-workspace", model: provider, idPrefix: "follower" });
    const created = await createReadyCase(leader);
    const input = {
      idempotencyKey: "cross-process-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      requestHypothesisSuggestions: true,
    };

    const firstRequest = leader.planner.plan(input);
    await started.promise;
    const pendingConflict = await follower.planner.plan({ ...input, requestHypothesisSuggestions: false });
    expect(pendingConflict).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    const secondRequest = follower.planner.plan(input);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    release.resolve({ claims: ["Small teams may copy reconciliation output between tools."] });

    const [first, second] = await Promise.all([firstRequest, secondRequest]);
    expect(first).toEqual(second);
    expect("error" in first).toBe(false);
    if (!("error" in first)) {
      expect(first.data.status).toBe("ready");
      expect(first.data.hypothesisSuggestions).toHaveLength(1);
      expect(first.data.hypothesisSuggestions[0]).toMatchObject({
        origin: "model_suggested",
        status: "unaccepted_suggestion",
      });
      expect(leader.repositories.suggestions.exists(first.data.hypothesisSuggestions[0].suggestionId)).toBe(true);
      const latest = leader.repositories.cases.get(created.caseId);
      expect(latest?.revision).toBe(created.revision);
      expect(latest?.hypothesisRevisions).toHaveLength(1);

      const accepted = await leader.cases.updateCase({
        idempotencyKey: "accept-suggestion-after-plan-key-001",
        caseId: created.caseId,
        expectedRevision: created.revision,
        hypothesisMutations: [{
          operation: "add",
          clientRef: "accepted-suggestion-1",
          claim: first.data.hypothesisSuggestions[0].claim,
          origin: "model_suggested",
          sourceSuggestionId: first.data.hypothesisSuggestions[0].suggestionId,
        }],
      });
      expect("error" in accepted).toBe(false);
      if (!("error" in accepted)) {
        expect(accepted.data.case.hypotheses.at(-1)).toMatchObject({
          origin: "model_suggested",
          sourceSuggestionId: first.data.hypothesisSuggestions[0].suggestionId,
          claim: first.data.hypothesisSuggestions[0].claim,
        });
      }
    }
    expect(leader.db.prepare("SELECT status FROM research_external_operations WHERE idempotency_key = ?")
      .get(input.idempotencyKey)).toEqual({ status: "completed" });
    const storedUsage = leader.db.prepare("SELECT usage_json FROM research_external_operations WHERE idempotency_key = ?")
      .get(input.idempotencyKey) as { usage_json: string | null };
    expect(JSON.parse(storedUsage.usage_json ?? "null")).toEqual({ inputTokens: 120, outputTokens: 40, costMicros: null });

    const conflictingPayload = await follower.planner.plan({ ...input, requestHypothesisSuggestions: false });
    expect(conflictingPayload).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(calls).toBe(1);
  });

  it("marks expired pending model operations unknown and never dispatches them again", async () => {
    let calls = 0;
    const harness = makeHarness({ model: mockModel(async () => {
      calls += 1;
      return { claims: ["Small teams may copy reconciliation output between tools."] };
    }) });
    const created = await createReadyCase(harness);
    const input = {
      idempotencyKey: "expired-model-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      requestHypothesisSuggestions: true,
    };
    const claimed = harness.repositories.externalOperations.reserve({
      operation: "research_plan",
      key: input.idempotencyKey,
      validatedInput: input,
      ownerId: "synthetic-crashed-owner",
      deadlineAt: new Date(Date.parse("2026-01-02T03:04:05.000Z") + 1_000).toISOString(),
    });
    expect(claimed.kind).toBe("claimed");
    harness.advance(2_000);

    const first = await harness.planner.plan(input);
    const second = await harness.planner.plan(input);
    expect(first).toMatchObject({
      error: { code: "INTERNAL_ERROR", retryable: false, message: expect.stringContaining("unknown outcome") },
    });
    expect(second).toEqual(first);
    expect(calls).toBe(0);
    expect(harness.db.prepare("SELECT status FROM research_external_operations WHERE idempotency_key = ?")
      .get(input.idempotencyKey)).toEqual({ status: "unknown" });
  });

  it("bounds duplicate waits by wall time even when the injected persistence clock is frozen", async () => {
    let calls = 0;
    const harness = makeHarness({
      limits: { ...TEST_LIMITS, maxWallTimeSeconds: 1 },
      model: mockModel(async () => {
        calls += 1;
        return { claims: ["Would not be requested while a durable owner is pending."] };
      }),
    });
    const created = await createReadyCase(harness);
    const input = {
      idempotencyKey: "frozen-clock-pending-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      requestHypothesisSuggestions: true,
    };
    harness.repositories.externalOperations.reserve({
      operation: "research_plan",
      key: input.idempotencyKey,
      validatedInput: input,
      ownerId: "synthetic-lost-owner",
      deadlineAt: new Date(Date.parse("2026-01-02T03:04:05.000Z") + 1_000).toISOString(),
    });

    const response = await harness.planner.plan(input);
    expect(response).toMatchObject({ error: { code: "INTERNAL_ERROR", retryable: false, message: expect.stringContaining("unknown outcome") } });
    expect(calls).toBe(0);
    expect(harness.db.prepare("SELECT status FROM research_external_operations WHERE idempotency_key = ?")
      .get(input.idempotencyKey)).toEqual({ status: "unknown" });
  });

  it("returns unknown for a provider that ignores service shutdown and never resolves", async () => {
    const started = deferred<void>();
    let providerSignal: AbortSignal | null = null;
    const harness = makeHarness({ model: mockModel((signal) => {
      providerSignal = signal;
      started.resolve();
      return new Promise<unknown>(() => undefined);
    }) });
    const created = await createReadyCase(harness);
    const input = {
      idempotencyKey: "shutdown-hanging-model-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      requestHypothesisSuggestions: true,
    };
    const pending = harness.planner.plan(input);
    await started.promise;
    harness.shutdown();

    const response = await pending;
    expect(response).toMatchObject({ error: { code: "INTERNAL_ERROR", retryable: false, message: expect.stringContaining("unknown outcome") } });
    expect(providerSignal?.aborted).toBe(true);
    expect(harness.db.prepare("SELECT status FROM research_external_operations WHERE idempotency_key = ?")
      .get(input.idempotencyKey)).toEqual({ status: "unknown" });
  });

  it("returns unknown at the provider deadline even if a provider ignores its abort signal", async () => {
    const started = deferred<void>();
    let providerSignal: AbortSignal | null = null;
    const harness = makeHarness({
      limits: { ...TEST_LIMITS, maxWallTimeSeconds: 1 },
      model: mockModel((signal) => {
        providerSignal = signal;
        started.resolve();
        return new Promise<unknown>(() => undefined);
      }),
    });
    const created = await createReadyCase(harness);
    const input = {
      idempotencyKey: "deadline-hanging-model-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      requestHypothesisSuggestions: true,
    };
    const pending = harness.planner.plan(input);
    await started.promise;

    const response = await pending;
    expect(response).toMatchObject({ error: { code: "INTERNAL_ERROR", retryable: false, message: expect.stringContaining("unknown outcome") } });
    expect(providerSignal?.aborted).toBe(true);
    expect(harness.db.prepare("SELECT status FROM research_external_operations WHERE idempotency_key = ?")
      .get(input.idempotencyKey)).toEqual({ status: "unknown" });
  });

  it("does not dispatch when shutdown occurs in the provider-start logger before model dispatch", async () => {
    let harness!: Harness;
    let calls = 0;
    harness = makeHarness({
      model: mockModel(async () => {
        calls += 1;
        return { claims: ["Small teams may copy reconciliation output between tools."] };
      }),
      onLog(entry) {
        if (entry.event === "provider.request_started") harness.shutdown();
      },
    });
    const created = await createReadyCase(harness);
    const input = {
      idempotencyKey: "shutdown-before-dispatch-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      requestHypothesisSuggestions: true,
    };

    const response = await harness.planner.plan(input);
    expect(response).toMatchObject({ error: { code: "INTERNAL_ERROR", message: "The research service is not active." } });
    expect(calls).toBe(0);
    expect(harness.db.prepare("SELECT status FROM research_external_operations WHERE idempotency_key = ?")
      .get(input.idempotencyKey)).toEqual({ status: "completed" });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM research_plans").get()).toEqual({ count: 0 });
  });

  it("does not create an offline plan when shutdown follows the first planning await", async () => {
    const harness = makeHarness();
    const created = await createReadyCase(harness);
    const pending = harness.planner.plan({
      idempotencyKey: "shutdown-before-local-write-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
    });
    harness.shutdown();

    const response = await pending;
    expect(response).toMatchObject({ error: { code: "INTERNAL_ERROR", message: "The research service is not active." } });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM research_plans").get()).toEqual({ count: 0 });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM research_idempotency_receipts WHERE operation = 'research_plan'").get())
      .toEqual({ count: 0 });
  });

  it("rechecks the case revision after model await and caches a safe stale result without saving suggestions", async () => {
    const started = deferred<void>();
    const release = deferred<unknown>();
    const harness = makeHarness({ model: mockModel(async () => {
      started.resolve();
      return release.promise;
    }) });
    const created = await createReadyCase(harness);
    const input = {
      idempotencyKey: "stale-after-model-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      requestHypothesisSuggestions: true,
    };
    const request = harness.planner.plan(input);
    await started.promise;
    const revised = await harness.cases.updateCase({
      idempotencyKey: "case-revision-during-model-key-001",
      caseId: created.caseId,
      expectedRevision: created.revision,
      intakePatch: { decisionMaker: "An operations lead." },
    });
    expect("error" in revised).toBe(false);
    release.resolve({ claims: ["Small teams may copy reconciliation output between tools."] });

    const response = await request;
    expect(response).toMatchObject({
      error: { code: "REVISION_CONFLICT", details: { expectedRevision: 1, currentRevision: 2 } },
    });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM research_hypothesis_suggestions").get()).toEqual({ count: 0 });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM research_plans").get()).toEqual({ count: 0 });
    expect(harness.db.prepare("SELECT status FROM research_external_operations WHERE idempotency_key = ?")
      .get(input.idempotencyKey)).toEqual({ status: "completed" });
  });

  it("caches a provider failure after dispatch rather than retrying it on replay", async () => {
    let calls = 0;
    const harness = makeHarness({ model: mockModel(async () => {
      calls += 1;
      throw new ResearchProviderError("failed");
    }) });
    const created = await createReadyCase(harness);
    const input = {
      idempotencyKey: "provider-failure-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      requestHypothesisSuggestions: true,
    };
    const first = await harness.planner.plan(input);
    const replay = await harness.planner.plan(input);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      error: { code: "INTERNAL_ERROR", retryable: false, message: expect.stringContaining("cached for this key") },
    });
    expect(calls).toBe(1);
  });

  it("stores safe provider usage even when returned suggestion claims fail validation", async () => {
    const harness = makeHarness({ model: mockModel(async () => ({ claims: [] })) });
    const created = await createReadyCase(harness);
    const input = {
      idempotencyKey: "malformed-output-plan-key-001",
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      requestHypothesisSuggestions: true,
    };

    const response = await harness.planner.plan(input);
    expect(response).toMatchObject({ error: { code: "INTERNAL_ERROR", retryable: false } });
    const operation = harness.db.prepare(`
      SELECT status, usage_json FROM research_external_operations WHERE idempotency_key = ?
    `).get(input.idempotencyKey) as { status: string; usage_json: string | null };
    expect(operation.status).toBe("completed");
    expect(JSON.parse(operation.usage_json ?? "null")).toEqual({ inputTokens: 120, outputTokens: 40, costMicros: null });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM research_plans").get()).toEqual({ count: 0 });
  });
});
