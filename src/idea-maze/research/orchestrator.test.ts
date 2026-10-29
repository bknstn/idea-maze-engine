import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { initSchema } from "../scripts/lib/schema.js";
import { hashSourceText } from "../scripts/lib/evidence-excerpts.js";
import { LlmInputBudgetError } from "../scripts/lib/llm.js";
import { createResearchContext, type ResearchContext } from "./context.js";
import type {
  ResearchLimits,
  ResearchResponse,
  ResearchPlanSnapshot,
  RunStatusResult,
} from "./contracts.js";
import {
  noResearchProviders,
  ResearchProviderError,
  type ModelProvider,
  type OriginalSourceReader,
  type ResearchProviderBindings,
  type SearchProvider,
} from "./ports.js";
import { createResearchApplication, type ComposedResearchApplication } from "./runtime.js";
import { createRegisteredModelBinding } from "./model-adapter.js";
import { SourceReaderError } from "./source-reader.js";

const TEST_LIMITS: ResearchLimits = {
  maxQueries: 8,
  maxFetchedPages: 8,
  maxFollowUpRounds: 1,
  maxWallTimeSeconds: 60,
  maxModelInputTokens: 10_000,
  maxModelOutputTokens: 2_000,
};

const SYNTHETIC_INTAKE = {
  ideaSummary: "A lightweight coordination board for small teams",
  targetUser: "Small product teams",
  problem: "Shared tasks become stale when owners are unclear",
  proposedSolution: "A compact board that highlights unowned work",
  currentAlternatives: ["A shared checklist"],
};

interface Harness {
  root: string;
  db: Database.Database;
  context: ResearchContext;
  application: ComposedResearchApplication;
}

let harness: Harness | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (!harness) return;
  await harness.application.shutdown();
  harness.context.dispose();
  if (harness.db.open) harness.db.close();
  fs.rmSync(harness.root, { recursive: true, force: true });
  harness = null;
});

describe("bounded research orchestration", () => {
  it("follows a named challenge gap using only an unused previewed query and assesses balanced evidence", async () => {
    const searchRequests: string[] = [];
    const modelCalls: string[] = [];
    const providers = makeProviders({
      search: {
        async search(request) {
          searchRequests.push(request.query);
          if (request.query === "supporting query preview") return searchResponse("https://example.com/support");
          if (request.query === "initial challenge preview") return searchResponse();
          if (request.query === "follow-up challenge preview") return searchResponse("https://example.com/challenge");
          throw new Error("An unpreviewed query was dispatched.");
        },
      },
      reader: {
        async fetchOriginal(request) {
          const text = request.url.endsWith("/support")
            ? "Synthetic teams repeatedly pay for a board that reveals unowned tasks."
            : "Synthetic teams resolve the same coordination issue with a shared checklist and no new tool.";
          return fetchedOriginal(request.url, text);
        },
      },
      model: {
        async generateJson<T>(request) {
          modelCalls.push(request.userPrompt);
          return { value: classifyFromPrompt(request.userPrompt) as T, usage: { inputTokens: 90, outputTokens: 60, costMicros: null } };
        },
      },
    });
    harness = createHarness(providers);
    const setup = await planRun(harness.application, [
      query("supporting query preview", "problem_language", "supporting"),
      query("initial challenge preview", "counterevidence", "challenging"),
      query("follow-up challenge preview", "counterevidence", "challenging"),
    ]);

    const run = await runToTerminal(harness.application, setup.runId);
    const result = responseData(await harness.application.result({ runId: setup.runId }));

    expect(run.status).toBe("completed");
    expect(run.stoppingReason).toBe("all_steps_finished");
    expect(searchRequests).toEqual([
      "supporting query preview",
      "initial challenge preview",
      "follow-up challenge preview",
    ]);
    expect(modelCalls).toHaveLength(2);
    expect(result.assessment?.outcome).toBe("mixed");
    expect(result.assessment?.claims[0]?.supportingEvidenceIds).toHaveLength(1);
    expect(result.assessment?.claims[0]?.challengingEvidenceIds).toHaveLength(1);
    expect(result.coverageGaps).toContainEqual(expect.objectContaining({
      reason: "no_results",
      queryId: setup.plan.queries[1]?.queryId,
      hypothesisId: setup.hypothesisId,
    }));
    expect(result.evidence.filter((item) => item.kind === "verified_excerpt")).toHaveLength(2);
  });

  it("returns an insufficient assessment when searches find no sources", async () => {
    const search = vi.fn(async () => searchResponse());
    const reader = vi.fn();
    const model = vi.fn();
    harness = createHarness(makeProviders({ search: { search }, reader: { fetchOriginal: reader }, model: { generateJson: model } }));
    const setup = await planRun(harness.application, [
      query("empty support preview", "problem_language", "supporting"),
      query("empty challenge preview", "counterevidence", "challenging"),
    ]);

    const run = await runToTerminal(harness.application, setup.runId);
    const result = responseData(await harness.application.result({ runId: setup.runId }));

    expect(run.status).toBe("completed");
    expect(result.assessment?.outcome).toBe("insufficient_evidence");
    expect(result.evidence).toEqual([]);
    expect(result.coverageGaps.filter((gap) => gap.reason === "no_results")).toHaveLength(2);
    expect(reader).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });

  it("keeps inaccessible originals as explicit gaps and never classifies snippets as evidence", async () => {
    const model = vi.fn();
    harness = createHarness(makeProviders({
      search: { async search() { return searchResponse("https://example.com/private-page"); } },
      reader: {
        async fetchOriginal() {
          throw new SourceReaderError("SOURCE_ACCESS_BLOCKED", "source_access_blocked", "Synthetic access policy blocked this source.");
        },
      },
      model: { generateJson: model },
    }));
    const setup = await planRun(harness.application, [
      query("inaccessible support preview", "problem_language", "supporting"),
      query("inaccessible challenge preview", "counterevidence", "challenging"),
    ]);

    const run = await runToTerminal(harness.application, setup.runId);
    const result = responseData(await harness.application.result({ runId: setup.runId }));

    expect(run.status).toBe("completed");
    expect(result.assessment?.outcome).toBe("insufficient_evidence");
    expect(result.evidence.every((item) => item.kind === "search_snippet")).toBe(true);
    expect(result.coverageGaps.some((gap) => gap.reason === "source_access_blocked")).toBe(true);
    expect(model).not.toHaveBeenCalled();
  });

  it("completes with provider gaps when collection capabilities are unavailable", async () => {
    harness = createHarness(noResearchProviders());
    const setup = await planRun(harness.application, [
      query("offline support preview", "problem_language", "supporting"),
      query("offline challenge preview", "counterevidence", "challenging"),
    ]);

    const run = await runToTerminal(harness.application, setup.runId);
    const result = responseData(await harness.application.result({ runId: setup.runId }));

    expect(run.status).toBe("completed");
    expect(run.stoppingReason).toBe("provider_unavailable");
    expect(result.assessment?.outcome).toBe("insufficient_evidence");
    expect(result.coverageGaps.some((gap) => gap.reason === "provider_unavailable")).toBe(true);
  });

  it("rejects fabricated model quotes while preserving discovery snippets", async () => {
    harness = createHarness(makeProviders({
      search: { async search() { return searchResponse("https://example.com/grounding"); } },
      reader: { async fetchOriginal(request) { return fetchedOriginal(request.url, "Only this synthetic sentence is present in the fetched original."); } },
      model: {
        async generateJson<T>(request) {
          const payload = JSON.parse(request.userPrompt) as { sources: Array<Record<string, unknown>>; hypotheses: Array<{ hypothesisId: string }> };
          const source = payload.sources[0]!;
          return {
            value: {
              candidates: [{
                sourceIndex: 0,
                hypothesisId: payload.hypotheses[0]!.hypothesisId,
                relationship: "supports",
                quote: "This fabricated quote was never fetched.",
                startUtf16: 0,
                endUtf16: 37,
                interpretation: "Synthetic fabricated classification.",
                sourceItemId: source.sourceItemId,
              }],
            } as T,
            usage: { inputTokens: 80, outputTokens: 50, costMicros: null },
          };
        },
      },
    }));
    const setup = await planRun(harness.application, [
      query("grounding support preview", "problem_language", "supporting"),
      query("grounding challenge preview", "counterevidence", "challenging"),
    ]);

    await runToTerminal(harness.application, setup.runId);
    const result = responseData(await harness.application.result({ runId: setup.runId }));

    expect(result.assessment?.outcome).toBe("insufficient_evidence");
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.every((item) => item.kind === "search_snippet")).toBe(true);
    expect(result.coverageGaps.some((gap) => gap.reason === "no_results")).toBe(true);
  });

  it("retains successful partial evidence when a later search request fails", async () => {
    harness = createHarness(makeProviders({
      search: {
        async search(request) {
          if (request.query.includes("support")) return searchResponse("https://example.com/partial");
          throw new ResearchProviderError("failed");
        },
      },
      reader: { async fetchOriginal(request) { return fetchedOriginal(request.url, "Synthetic evidence supports a narrow coordination need."); } },
      model: { async generateJson<T>(request) { return { value: classifyFromPrompt(request.userPrompt) as T, usage: { inputTokens: 80, outputTokens: 50, costMicros: null } }; } },
    }));
    const setup = await planRun(harness.application, [
      query("support partial preview", "problem_language", "supporting"),
      query("challenge partial preview", "counterevidence", "challenging"),
    ]);

    const run = await runToTerminal(harness.application, setup.runId);
    const result = responseData(await harness.application.result({ runId: setup.runId }));

    expect(run.status).toBe("completed");
    expect(result.assessment?.outcome).toBe("supported");
    expect(result.evidence.some((item) => item.kind === "verified_excerpt")).toBe(true);
    expect(result.coverageGaps.some((gap) => gap.reason === "search_failed")).toBe(true);
  });

  it("preserves discovery and coverage on explicit cancellation during original retrieval", async () => {
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    harness = createHarness(makeProviders({
      search: { async search() { return searchResponse("https://example.com/slow-original"); } },
      reader: {
        fetchOriginal(request) {
          markFetchStarted?.();
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
          });
        },
      },
      model: { async generateJson<T>(request) { return { value: classifyFromPrompt(request.userPrompt) as T, usage: { inputTokens: 80, outputTokens: 50, costMicros: null } }; } },
    }));
    const setup = await planRun(harness.application, [
      query("cancel support preview", "problem_language", "supporting"),
      query("cancel challenge preview", "counterevidence", "challenging"),
    ]);
    await waitFor(fetchStarted, 2_000);
    responseData(await harness.application.cancel({ runId: setup.runId, idempotencyKey: "cancel-synthetic-run" }));

    const run = await runToTerminal(harness.application, setup.runId);
    const result = responseData(await harness.application.result({ runId: setup.runId }));

    expect(run.status).toBe("cancelled");
    expect(result.assessment).toBeNull();
    expect(result.evidence.some((item) => item.kind === "search_snippet")).toBe(true);
    expect(result.coverageGaps.some((gap) => gap.reason === "cancelled")).toBe(true);
  });

  it("stops external work at the page budget and exposes a limit stopping reason", async () => {
    const reader = vi.fn(async (request: Parameters<OriginalSourceReader["fetchOriginal"]>[0]) =>
      fetchedOriginal(request.url, "Synthetic source text has a narrow verified claim."));
    const search = vi.fn(async (request: Parameters<SearchProvider["search"]>[0]) => searchResponse(request.query.includes("support")
      ? "https://example.com/one-page"
      : "https://example.com/second-page"));
    harness = createHarness(makeProviders({
      search: { search },
      reader: { fetchOriginal: reader },
      model: { async generateJson<T>(request) { return { value: classifyFromPrompt(request.userPrompt) as T, usage: { inputTokens: 70, outputTokens: 40, costMicros: null } }; } },
    }), { ...TEST_LIMITS, maxFetchedPages: 1, maxQueries: 3 });
    const setup = await planRun(harness.application, [
      query("support budget preview", "problem_language", "supporting"),
      query("challenge budget preview", "counterevidence", "challenging"),
      query("follow-up budget preview", "counterevidence", "challenging"),
    ], { ...TEST_LIMITS, maxFetchedPages: 1, maxQueries: 3 });

    const run = await runToTerminal(harness.application, setup.runId);

    expect(run.status).toBe("completed");
    expect(run.usage.fetchedPages).toBe(1);
    expect(reader).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledTimes(2);
    expect(run.coverageGaps.some((gap) => gap.reason === "budget_exhausted")).toBe(true);
    expect(run.coverageGaps.some((gap) => gap.reason === "budget_exhausted" &&
      gap.queryId === setup.plan.queries[2]?.queryId)).toBe(true);
    expect(run.stoppingReason).toBe("limit_reached");
  });

  it("retains URL-only leads and stops new searches at the discovery-capacity boundary", async () => {
    const searchQueries: string[] = [];
    const providers = makeProviders({
      search: {
        async search(request) {
          searchQueries.push(request.query);
          const queryNumber = searchQueries.length;
          return {
            results: Array.from({ length: 20 }, (_unused, index) => ({
              url: `https://example.com/capacity/${queryNumber}-${index}`,
              title: null,
              snippet: null,
            })),
            requestsUsed: 1,
            costMicros: null,
          };
        },
      },
      reader: { async fetchOriginal(request) { return fetchedOriginal(request.url, "Synthetic original text only."); } },
      model: {
        async generateJson<T>() {
          return { value: { candidates: [] } as T, usage: { inputTokens: 10, outputTokens: 5, costMicros: null } };
        },
      },
    });
    const limits = { ...TEST_LIMITS, maxQueries: 26, maxFetchedPages: 20, maxFollowUpRounds: 0 };
    harness = createHarness(providers, limits);
    const created = responseData(await harness.application.createCase({
      idempotencyKey: "create-capacity-case",
      intake: SYNTHETIC_INTAKE,
      hypotheses: Array.from({ length: 13 }, (_unused, index) => ({ claim: `Synthetic test hypothesis ${index + 1}.` })),
    }));
    const queryDrafts = created.case.hypotheses.flatMap((hypothesis, index) => [
      query(`capacity support query ${index + 1}`, "problem_language", "supporting"),
      query(`capacity challenge query ${index + 1}`, "counterevidence", "challenging"),
    ]).map((draft, index) => ({ ...draft, hypothesisIds: [created.case.hypotheses[Math.floor(index / 2)]!.hypothesisId] }));
    const plan = responseData(await harness.application.plan({
      idempotencyKey: "plan-capacity-case",
      caseId: created.case.caseId,
      expectedCaseRevision: created.case.revision,
      suppliedPlan: { queries: queryDrafts, limits },
    })).plan;
    if (!plan) throw new Error("Synthetic discovery-capacity plan was not ready.");
    const started = responseData(await harness.application.start({
      idempotencyKey: "start-capacity-run",
      caseId: created.case.caseId,
      expectedCaseRevision: created.case.revision,
      planId: plan.planId,
    }));

    const run = await runToTerminal(harness.application, started.runId);
    const result = responseData(await harness.application.result({ runId: started.runId }));

    expect(run.status).toBe("completed");
    expect(run.stoppingReason).toBe("limit_reached");
    expect(searchQueries).toHaveLength(25);
    expect(result.pagination.totalEvidence).toBe(500);
    expect(result.evidence.filter((item) => item.kind === "search_snippet")
      .every((item) => item.kind === "search_snippet" && item.text.includes("No search excerpt was supplied"))).toBe(true);
    expect(result.coverageGaps.some((gap) => gap.reason === "budget_exhausted" && gap.queryId === plan.queries[25]?.queryId)).toBe(true);
  });

  it("does not retry a failed original URL during a bounded follow-up round", async () => {
    const fetchOriginal = vi.fn(async () => {
      throw new SourceReaderError("SOURCE_ACCESS_BLOCKED", "source_access_blocked", "Synthetic inaccessible source.");
    });
    harness = createHarness(makeProviders({
      search: {
        async search(request) {
          if (request.query === "support retry preview" || request.query === "follow-up retry preview") {
            return searchResponse("https://example.com/failed-once");
          }
          return searchResponse();
        },
      },
      reader: { fetchOriginal },
      model: { async generateJson<T>() { return { value: { candidates: [] } as T, usage: { inputTokens: 10, outputTokens: 5, costMicros: null } }; } },
    }));
    const setup = await planRun(harness.application, [
      query("support retry preview", "problem_language", "supporting"),
      query("initial retry challenge", "counterevidence", "challenging"),
      query("follow-up retry preview", "counterevidence", "challenging"),
    ]);

    await runToTerminal(harness.application, setup.runId);
    const result = responseData(await harness.application.result({ runId: setup.runId }));

    expect(fetchOriginal).toHaveBeenCalledOnce();
    expect(result.coverageGaps.some((gap) => gap.detail.includes("first retrieval attempt already failed"))).toBe(true);
  });

  it("admits a bounded many-source prompt through the registered built-in model adapter", async () => {
    const sourceText = "Synthetic public source passage with a testable coordination claim. ".repeat(100);
    const sentSourceCounts: number[] = [];
    const mockFetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const payload = JSON.parse(requestBody.messages[1]!.content) as {
        hypotheses: Array<{ hypothesisId: string }>;
        sources: Array<{ sourceIndex: number; text: string }>;
      };
      sentSourceCounts.push(payload.sources.length);
      const candidates = payload.sources.map((source) => ({
        sourceIndex: source.sourceIndex,
        hypothesisId: payload.hypotheses[0]!.hypothesisId,
        relationship: "supports",
        quote: source.text.slice(0, Math.min(120, source.text.length)),
        startUtf16: 0,
        endUtf16: Math.min(120, source.text.length),
        interpretation: "A synthetic exact excerpt supports the narrow hypothesis.",
      }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ candidates }) } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", mockFetch);
    const limits = { ...TEST_LIMITS, maxQueries: 2, maxFetchedPages: 20, maxModelInputTokens: 10_000, maxModelOutputTokens: 10_000 };
    const modelBinding = createRegisteredModelBinding({ environment: { OPENAI_API_KEY: "synthetic-key" } });
    harness = createHarness({
      model: modelBinding,
      originalSourceReader: {
        availability: "available",
        adapter: "synthetic-reader",
        provider: { async fetchOriginal(request) { return fetchedOriginal(request.url, sourceText); } },
      },
      search: {
        availability: "available",
        adapter: "synthetic-search",
        provider: {
          async search(request) {
            return {
              results: request.query.includes("support")
                ? Array.from({ length: 20 }, (_unused, index) => ({
                  url: `https://example.com/many-source/${index}`,
                  title: null,
                  snippet: null,
                }))
                : [],
              requestsUsed: 1,
              costMicros: null,
            };
          },
        },
      },
    }, limits);
    const setup = await planRun(harness.application, [
      query("many-source support preview", "problem_language", "supporting"),
      query("many-source challenge preview", "counterevidence", "challenging"),
    ], limits);

    const run = await runToTerminal(harness.application, setup.runId);
    const result = responseData(await harness.application.result({ runId: setup.runId }));

    expect(run.status).toBe("completed");
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(sentSourceCounts[0]).toBeGreaterThan(0);
    expect(result.evidence.some((item) => item.kind === "verified_excerpt")).toBe(true);
    expect(result.evidence.some((item) => item.kind === "search_snippet" && item.text.includes("No search excerpt was supplied"))).toBe(true);
  });

  it("classifies provider rate limits and unsupported input bounds as unavailable rather than budget exhaustion", async () => {
    for (const error of [new ResearchProviderError("rate_limited"), new LlmInputBudgetError("unsupported")]) {
      harness = createHarness(makeProviders({
        search: { async search() { return searchResponse("https://example.com/provider-limited"); } },
        reader: { async fetchOriginal(request) { return fetchedOriginal(request.url, "Synthetic source text for provider failure."); } },
        model: { async generateJson<T>() { throw error; } },
      }));
      const setup = await planRun(harness.application, [
        query("provider failure support", "problem_language", "supporting"),
        query("provider failure challenge", "counterevidence", "challenging"),
      ]);

      const run = await runToTerminal(harness.application, setup.runId);
      const result = responseData(await harness.application.result({ runId: setup.runId }));
      expect(run.status).toBe("completed");
      expect(run.stoppingReason).toBe("provider_unavailable");
      expect(result.coverageGaps.some((gap) => gap.reason === "provider_unavailable")).toBe(true);
      expect(result.coverageGaps.some((gap) => gap.reason === "budget_exhausted")).toBe(false);
      await harness.application.shutdown();
      harness.context.dispose();
      if (harness.db.open) harness.db.close();
      fs.rmSync(harness.root, { recursive: true, force: true });
      harness = null;
    }
  });
});

function createHarness(providers: ResearchProviderBindings, limits = TEST_LIMITS): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "idea-maze-orchestrator-"));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  const context = createResearchContext({
    database: { ownership: "borrowed", connection: db },
    paths: { workspaceRoot: root, databaseFile: null },
    workspaceKey: "synthetic-orchestrator-workspace",
    clock: { now: () => new Date("2026-10-29T10:00:00.000Z") },
    logger: { log: () => undefined },
    providers,
    serviceLifetimeSignal: new AbortController().signal,
    limits,
    idFactory: deterministicIds(),
  });
  return { root, db, context, application: createResearchApplication(context) };
}

function makeProviders(options: {
  search: SearchProvider;
  reader: OriginalSourceReader;
  model: ModelProvider;
}): ResearchProviderBindings {
  return {
    search: { availability: "available", adapter: "synthetic-search", provider: options.search },
    originalSourceReader: { availability: "available", adapter: "synthetic-reader", provider: options.reader },
    model: { availability: "available", adapter: "synthetic-model", provider: options.model },
  };
}

function query(text: string, purpose: "problem_language" | "workaround" | "alternative" | "counterevidence", evidenceIntent: "supporting" | "challenging") {
  return { text, purpose, evidenceIntent, hypothesisIds: [] as string[], sourceScopes: ["public_web" as const] };
}

async function planRun(
  application: ComposedResearchApplication,
  queryDrafts: ReturnType<typeof query>[],
  planLimits = TEST_LIMITS,
): Promise<{ runId: string; hypothesisId: string; plan: ResearchPlanSnapshot }> {
  const created = responseData(await application.createCase({
    idempotencyKey: "create-synthetic-case",
    intake: SYNTHETIC_INTAKE,
    hypotheses: [{ claim: "Small teams will pay for a board that reduces stale shared tasks." }],
  }));
  const hypothesisId = created.case.hypotheses[0]!.hypothesisId;
  const plan = responseData(await application.plan({
    idempotencyKey: "plan-synthetic-case",
    caseId: created.case.caseId,
    expectedCaseRevision: created.case.revision,
    suppliedPlan: {
      queries: queryDrafts.map((entry) => ({ ...entry, hypothesisIds: [hypothesisId] })),
      limits: planLimits,
    },
  })).plan;
  if (!plan) throw new Error("The synthetic plan was not ready.");
  const started = responseData(await application.start({
    idempotencyKey: "start-synthetic-run",
    caseId: created.case.caseId,
    expectedCaseRevision: created.case.revision,
    planId: plan.planId,
  }));
  return { runId: started.runId, hypothesisId, plan };
}

async function runToTerminal(application: ComposedResearchApplication, runId: string): Promise<RunStatusResult> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const status = responseData(await application.status({ runId }));
    if (["completed", "failed", "cancelled", "interrupted"].includes(status.status)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("The synthetic research run did not reach a terminal state.");
}

function responseData<T>(response: ResearchResponse<T>): T {
  if (!("data" in response)) throw new Error(`Synthetic application request failed: ${response.error.code}`);
  return response.data;
}

function searchResponse(url?: string) {
  return {
    results: url ? [{ url, title: "Synthetic source", snippet: "A synthetic discovery snippet that is not evidence." }] : [],
    requestsUsed: 1,
    costMicros: null,
  };
}

function fetchedOriginal(url: string, text: string) {
  return {
    canonicalUrl: url,
    retrievedAt: "2026-10-29T10:00:00.000Z",
    title: "Synthetic original",
    contentType: "text/plain",
    text,
    textHash: hashSourceText(text),
  };
}

function classifyFromPrompt(prompt: string): unknown {
  const payload = JSON.parse(prompt) as {
    hypotheses: Array<{ hypothesisId: string }>;
    sources: Array<{
      sourceIndex: number;
      sourceItemId: number;
      sourceTextHash: string;
      retrievedAt: string;
      canonicalUrl: string;
      text: string;
    }>;
  };
  return {
    candidates: payload.sources.map((source) => ({
      sourceIndex: source.sourceIndex,
      hypothesisId: payload.hypotheses[0]!.hypothesisId,
      relationship: source.text.includes("resolve the same coordination") ? "contradicts" : "supports",
      quote: source.text,
      startUtf16: 0,
      endUtf16: source.text.length,
      interpretation: source.text.includes("resolve the same coordination")
        ? "This example challenges the claim with a manual workaround."
        : "This example supports the narrow claim with a concrete paid workaround.",
    })),
  };
}

function deterministicIds(): (kind: string) => string {
  const counters = new Map<string, number>();
  return (kind) => {
    const next = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, next);
    return `${kind}_synthetic_${next}`;
  };
}

async function waitFor(promise: Promise<void>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for synthetic source retrieval.")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
