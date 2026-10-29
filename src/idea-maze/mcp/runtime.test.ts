import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";

import { createResearchRuntime } from "../research/runtime.js";
import { noResearchProviders, type ResearchProviderBindings, type SearchProvider } from "../research/ports.js";
import type { ResearchApplication, ResearchCase, ResearchPlanSnapshot, RunStatusResult } from "../research/contracts.js";
import { listenStreamableHttpResearchServer } from "./transports/streamable-http.js";
import { createHttpSecurityConfiguration } from "./security/http-validation.js";
import { startResearchMcpProcess } from "../scripts/research-mcp.js";

const runtimeChild = fileURLToPath(new URL("./fixtures/runtime-stdio-child.ts", import.meta.url));
const activeClients: Client[] = [];
const activeServices: Array<{ close(): Promise<void> }> = [];
const activeRuntimes: Array<{ shutdown(): Promise<void> }> = [];
const workspaceRoots: string[] = [];
const TEST_TOKEN = "synthetic_runtime_bearer_token_012345678901234567890123456789";

interface ProviderCalls {
  model: number;
  search: number;
  originalSourceReader: number;
}

interface SearchGate {
  started: Promise<void>;
  release(): void;
  provider: SearchProvider;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createProviders(
  calls: ProviderCalls,
  search: SearchProvider = {
    async search() {
      return { results: [], requestsUsed: 1, costMicros: null };
    },
  },
): ResearchProviderBindings {
  const countedSearch: SearchProvider = {
    async search(request) {
      calls.search += 1;
      return search.search(request);
    },
  };
  return {
    model: {
      availability: "available",
      adapter: "synthetic-runtime-test",
      provider: {
        async generateJson<T>() {
          calls.model += 1;
          return { value: { candidates: [] } as T, usage: { inputTokens: 10, outputTokens: 5, costMicros: null } };
        },
      },
    },
    search: { availability: "available", adapter: "synthetic-runtime-test", provider: countedSearch },
    originalSourceReader: {
      availability: "available",
      adapter: "synthetic-runtime-test",
      provider: {
        async fetchOriginal() {
          calls.originalSourceReader += 1;
          throw new Error("Empty synthetic searches must not fetch an original.");
        },
      },
    },
  };
}

function createBlockingSearch(options: { stopOnAbort?: boolean } = {}): SearchGate {
  const entered = deferred();
  const releaseSignal = deferred();
  const provider: SearchProvider = {
    async search({ signal }) {
      entered.resolve();
      if (options.stopOnAbort) {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new DOMException("Synthetic search aborted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason ?? new DOMException("Synthetic search aborted", "AbortError"));
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          void releaseSignal.promise.then(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          });
        });
      }
      return { results: [], requestsUsed: 1, costMicros: null };
    },
  };
  return { started: entered.promise, release: releaseSignal.resolve, provider };
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "idea-maze-mcp-runtime-test-"));
  workspaceRoots.push(root);
  return root;
}

function makeRuntime(root: string, providers: ResearchProviderBindings) {
  const runtime = createResearchRuntime({
    workspaceRoot: root,
    environment: {},
    providers,
  });
  activeRuntimes.push(runtime);
  return runtime;
}

function createClient(name: string): Client {
  const client = new Client({ name, version: "1.0.0" });
  activeClients.push(client);
  return client;
}

function createSecurity() {
  return createHttpSecurityConfiguration({
    credentials: [{ id: "synthetic-owner", token: TEST_TOKEN, expiresAt: Date.now() + 60 * 60 * 1000 }],
    allowedHosts: ["127.0.0.1", "localhost", "::1"],
    allowedOrigins: [],
  });
}

function responseData<T>(result: { structuredContent?: unknown }): T {
  const response = result.structuredContent as { data?: T; error?: { message?: string } } | undefined;
  if (!response || !("data" in response)) {
    throw new Error(response?.error?.message ?? "Expected a structured MCP success response.");
  }
  return response.data as T;
}

async function startHttp(app: ResearchApplication, onShutdown: () => Promise<void>) {
  const service = await listenStreamableHttpResearchServer({
    app,
    port: 0,
    security: createSecurity(),
    onShutdown,
  });
  activeServices.push(service);
  return service;
}

async function connectHttp(client: Client, url: URL): Promise<void> {
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
  }));
}

async function createCaseAndPlan(client: Client, suffix: string): Promise<{ researchCase: ResearchCase; plan: ResearchPlanSnapshot }> {
  const createdResult = await client.callTool({
    name: "research_case_create",
    arguments: {
      idempotencyKey: `runtime-create-${suffix}-001`,
      intake: {
        ideaSummary: "A synthetic helper for a recurring workflow.",
        targetUser: "Small operations teams.",
        problem: "A repeated manual review takes too much time each week.",
        proposedSolution: "A focused workflow helper.",
      },
      hypotheses: [{ claim: "Small operations teams repeat a manual review each week." }],
    },
  });
  const created = responseData<{ case: ResearchCase }>(createdResult).case;

  const readResult = await client.callTool({ name: "research_case_get", arguments: { caseId: created.caseId } });
  expect(responseData<ResearchCase>(readResult).revision).toBe(1);

  const hypothesisId = created.hypotheses[0]?.hypothesisId;
  if (!hypothesisId) throw new Error("The synthetic case should include one active hypothesis.");
  const plannedResult = await client.callTool({
    name: "research_plan",
    arguments: {
      idempotencyKey: `runtime-plan-${suffix}-001`,
      caseId: created.caseId,
      expectedCaseRevision: created.revision,
      suppliedPlan: {
        queries: [
          {
            text: "How do small teams describe this repeated workflow problem?",
            purpose: "problem_language",
            evidenceIntent: "supporting",
            hypothesisIds: [hypothesisId],
            sourceScopes: ["public_web"],
          },
          {
            text: "What counterexamples challenge this repeated workflow problem?",
            purpose: "counterevidence",
            evidenceIntent: "challenging",
            hypothesisIds: [hypothesisId],
            sourceScopes: ["community_discussions"],
          },
        ],
        limits: {
          maxQueries: 2,
          maxFetchedPages: 2,
          maxFollowUpRounds: 0,
          maxWallTimeSeconds: 30,
          maxModelInputTokens: 1_000,
          maxModelOutputTokens: 500,
        },
      },
    },
  });
  const planned = responseData<{ status: string; plan: ResearchPlanSnapshot | null }>(plannedResult);
  if (planned.status !== "ready" || !planned.plan) throw new Error("The supplied synthetic plan should be ready.");
  return { researchCase: created, plan: planned.plan };
}

async function startRun(client: Client, researchCase: ResearchCase, plan: ResearchPlanSnapshot, suffix: string) {
  const result = await client.callTool({
    name: "research_start",
    arguments: {
      idempotencyKey: `runtime-start-${suffix}-001`,
      caseId: researchCase.caseId,
      expectedCaseRevision: researchCase.revision,
      planId: plan.planId,
    },
  });
  return responseData<{ runId: string; status: string }>(result);
}

async function pollUntilTerminal(client: Client, runId: string, timeoutMilliseconds = 5_000): Promise<RunStatusResult> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: "research_status", arguments: { runId } });
    const status = responseData<RunStatusResult>(result);
    if (["completed", "failed", "cancelled", "interrupted"].includes(status.status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("The synthetic runtime run did not reach a terminal status in time.");
}

async function pollUntilSearchStarts(client: Client, runId: string, timeoutMilliseconds = 5_000): Promise<RunStatusResult> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: "research_status", arguments: { runId } });
    const status = responseData<RunStatusResult>(result);
    if (status.steps.some((step) => step.name === "search" && step.status === "running")) return status;
    if (["completed", "failed", "cancelled", "interrupted"].includes(status.status)) {
      throw new Error("The synthetic runtime run stopped before its search step started.");
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("The synthetic runtime search step did not start in time.");
}

async function within<T>(promise: Promise<T>, timeoutMilliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("MCP response exceeded the prompt-response bound.")), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

afterEach(async () => {
  for (const client of activeClients.splice(0)) await client.close().catch(() => undefined);
  for (const service of activeServices.splice(0)) await service.close().catch(() => undefined);
  for (const runtime of activeRuntimes.splice(0)) await runtime.shutdown().catch(() => undefined);
  for (const root of workspaceRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP runtime composition", () => {
  it("runs the real application over loopback HTTP and keeps service work across reconnects", async () => {
    const calls: ProviderCalls = { model: 0, search: 0, originalSourceReader: 0 };
    const gate = createBlockingSearch();
    const runtime = makeRuntime(makeWorkspace(), createProviders(calls, gate.provider));
    const service = await startHttp(runtime.application, runtime.shutdown);
    const first = createClient("synthetic-runtime-http-first");
    await connectHttp(first, service.url);

    const capabilities = responseData<{ capabilities: Record<string, { availability: string }> }>(
      await first.callTool({ name: "research_capabilities", arguments: {} }),
    );
    expect(capabilities.capabilities.search.availability).toBe("available");
    const { researchCase, plan } = await createCaseAndPlan(first, "http");
    expect(calls).toEqual({ model: 0, search: 0, originalSourceReader: 0 });

    const receipt = await within(startRun(first, researchCase, plan, "http"), 1_500);
    expect(receipt.status).toBe("queued");
    await gate.started;
    expect(calls.search).toBe(1);

    await first.close();
    const reconnect = createClient("synthetic-runtime-http-reconnect");
    await connectHttp(reconnect, service.url);
    const running = responseData<RunStatusResult>(await reconnect.callTool({
      name: "research_status",
      arguments: { runId: receipt.runId },
    }));
    expect(["queued", "running"]).toContain(running.status);
    const partialRead = responseData<{ runId: string }>(await reconnect.callTool({
      name: "research_result",
      arguments: { runId: receipt.runId, limit: 10 },
    }));
    expect(partialRead.runId).toBe(receipt.runId);
    expect(calls.search).toBe(1);
    expect(calls.model).toBe(0);
    expect(calls.originalSourceReader).toBe(0);

    gate.release();
    const terminal = await pollUntilTerminal(reconnect, receipt.runId);
    expect(terminal.status).toBe("completed");
    const final = responseData<{ runId: string; assessment: { outcome: string } | null; evidence: unknown[] }>(
      await reconnect.callTool({ name: "research_result", arguments: { runId: receipt.runId, limit: 10 } }),
    );
    expect(final.runId).toBe(receipt.runId);
    expect(final.assessment?.outcome).toBe("insufficient_evidence");
    expect(final.evidence).toEqual([]);
    expect(calls.search).toBe(2);
    expect(calls.model).toBe(0);
    expect(calls.originalSourceReader).toBe(0);
  });

  it("starts the executable's default HTTP transport from a secret environment snapshot", async () => {
    const workspaceRoot = makeWorkspace();
    const processHandle = await startResearchMcpProcess({
      environment: {
        IDEA_MAZE_HOME: workspaceRoot,
        IDEA_MAZE_MCP_BEARER_TOKEN: TEST_TOKEN,
        IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        IDEA_MAZE_MCP_HTTP_PORT: "0",
      },
    });
    activeServices.push(processHandle);
    const url = processHandle.url;
    if (!url) throw new Error("The default executable transport should expose its loopback URL.");
    expect(url.pathname).toBe("/mcp");

    const anonymous = await fetch(url);
    expect(anonymous.status).toBe(401);
    const health = await fetch(new URL("/healthz", url));
    expect(health.status).toBe(200);

    const client = createClient("synthetic-runtime-executable");
    await connectHttp(client, url);
    const capabilities = responseData<{ storageMode: string }>(
      await client.callTool({ name: "research_capabilities", arguments: {} }),
    );
    expect(capabilities.storageMode).toBe("single_owner_workspace");
  });

  it("removes process signal listeners after injected stdio EOF", async () => {
    const workspaceRoot = makeWorkspace();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const initialSigintListeners = process.listenerCount("SIGINT");
    const initialSigtermListeners = process.listenerCount("SIGTERM");
    const processHandle = await startResearchMcpProcess({
      environment: { IDEA_MAZE_HOME: workspaceRoot, IDEA_MAZE_MCP_TRANSPORT: "stdio" },
      stdin,
      stdout,
    });
    activeServices.push(processHandle);
    expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners + 1);
    expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners + 1);

    const eof = new Promise<void>((resolve) => stdin.once("end", () => resolve()));
    stdin.end();
    await eof;
    await processHandle.close();
    expect(process.listenerCount("SIGINT")).toBe(initialSigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(initialSigtermListeners);
    stdin.destroy();
    stdout.destroy();
  });

  it("routes explicit cancellation to service-owned provider work", async () => {
    const calls: ProviderCalls = { model: 0, search: 0, originalSourceReader: 0 };
    const gate = createBlockingSearch({ stopOnAbort: true });
    const runtime = makeRuntime(makeWorkspace(), createProviders(calls, gate.provider));
    const service = await startHttp(runtime.application, runtime.shutdown);
    const client = createClient("synthetic-runtime-http-cancel");
    await connectHttp(client, service.url);
    const { researchCase, plan } = await createCaseAndPlan(client, "cancel");
    const receipt = await startRun(client, researchCase, plan, "cancel");
    await gate.started;

    const cancellation = responseData<{ status: string; cancellationRequested: boolean }>(await client.callTool({
      name: "research_cancel",
      arguments: { runId: receipt.runId, idempotencyKey: "runtime-cancel-001" },
    }));
    expect(cancellation.cancellationRequested).toBe(true);
    expect(calls.search).toBe(1);
    const terminal = await pollUntilTerminal(client, receipt.runId);
    expect(terminal.status).toBe("cancelled");
    expect(terminal.stoppingReason).toBe("cancelled");
  });

  it("treats stdio EOF as service shutdown and persists the active run interruption", async () => {
    const workspaceRoot = makeWorkspace();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", runtimeChild],
      cwd: process.cwd(),
      env: { IDEA_MAZE_HOME: workspaceRoot, IDEA_MAZE_TEST_SEARCH_DELAY_MS: "5000" },
      stderr: "pipe",
      maxBufferSize: 256 * 1024,
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const client = createClient("synthetic-runtime-stdio-eof");
    await client.connect(transport);
    const { researchCase, plan } = await createCaseAndPlan(client, "stdio");
    const receipt = await within(startRun(client, researchCase, plan, "stdio"), 1_500);
    const running = await pollUntilSearchStarts(client, receipt.runId);
    expect(["queued", "running"]).toContain(running.status);

    await client.close();
    expect(stderr).toBe("");

    const reader = createResearchRuntime({ workspaceRoot, environment: {}, providers: noResearchProviders() });
    activeRuntimes.push(reader);
    const afterEofResponse = await reader.application.status({ runId: receipt.runId });
    if ("error" in afterEofResponse) throw new Error(afterEofResponse.error.message);
    const afterEof = afterEofResponse.data;
    expect(afterEof.status).toBe("interrupted");
    expect(afterEof.stoppingReason).toBe("service_shutdown");
  });
});
