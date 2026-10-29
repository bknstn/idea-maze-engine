import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createResearchRuntime } from "../research/runtime.js";
import {
  RESEARCH_SCHEMA_VERSION,
  type ResearchLimits,
  type ResearchApplication,
  type ResearchResponse,
  type RunExecutionStatus,
  type RunStatusResult,
  type StartRunResult,
} from "../research/contracts.js";
import type { ResearchProviderBindings } from "../research/ports.js";
import { runResearchCli, type ResearchCliDependencies } from "./research-cli.js";

const START: StartRunResult = {
  runId: "run_cli_synthetic_01",
  status: "queued",
  caseId: "case_cli_synthetic_01",
  caseRevision: 1,
  planId: "plan_cli_synthetic_01",
  acceptedAt: "2026-01-01T00:00:00.000Z",
};

function status(status: RunExecutionStatus): RunStatusResult {
  return {
    runId: START.runId,
    caseId: START.caseId,
    caseRevision: 1,
    planId: START.planId,
    status,
    steps: [],
    usage: {
      searchRequests: 0,
      fetchedPages: 0,
      modelInputTokens: null,
      modelOutputTokens: null,
      providerCostMicros: null,
      elapsedMilliseconds: 0,
    },
    coverageGaps: [],
    stoppingReason: status === "completed" ? "all_steps_finished" : null,
    createdAt: START.acceptedAt,
    startedAt: START.acceptedAt,
    finishedAt: status === "completed" || status === "cancelled" ? START.acceptedAt : null,
    cancelRequestedAt: status === "cancelled" ? START.acceptedAt : null,
  };
}

function resultPage(format: "json" | "markdown" = "json") {
  return {
    runId: START.runId,
    assessment: {
      outcome: "insufficient_evidence" as const,
      summary: "Synthetic assessment.",
      rationale: "No provider calls are made by this fixture.",
      claims: [],
      coverageGaps: [],
      nextExperiment: "Review the synthetic result.",
    },
    evidence: [],
    coverageGaps: [],
    pagination: { nextCursor: null, hasMore: false, totalEvidence: 0 },
    reportMarkdown: format === "markdown" ? "# Synthetic assessment\n" : null,
  };
}

function response<T>(data: T): ResearchResponse<T> {
  return { schemaVersion: RESEARCH_SCHEMA_VERSION, data };
}

function makeHarness(overrides: Partial<ResearchApplication> = {}, additions: Partial<ResearchCliDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const app = {
    capabilities: vi.fn(async () => response({ capabilities: {}, limits: {}, storageMode: "single_owner_workspace" })),
    createCase: vi.fn(async () => response({ case: {} })),
    getCase: vi.fn(async () => response({})),
    updateCase: vi.fn(async () => response({ case: {} })),
    plan: vi.fn(async () => response({})),
    start: vi.fn(async () => response(START)),
    status: vi.fn(async () => response(status("completed"))),
    result: vi.fn(async (input: { format?: "json" | "markdown" }) => response(resultPage(input.format))),
    cancel: vi.fn(async () => response({ runId: START.runId, status: "cancelled", cancellationRequested: true, cancelRequestedAt: START.acceptedAt })),
    ...overrides,
  } as unknown as ResearchApplication;
  const dependencies: ResearchCliDependencies = {
    app,
    stdin: emptyInput(),
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
    ...additions,
  };
  return { app, dependencies, stdout, stderr };
}

async function* emptyInput(): AsyncIterable<string> {}

async function* jsonInput(value: string): AsyncIterable<string> {
  yield value;
}

function parsedOutput(output: string[]): unknown {
  return JSON.parse(output.join(""));
}

describe("research CLI core", () => {
  it("answers process --help without constructing a runtime for an invalid workspace", () => {
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "src/idea-maze/scripts/research-cli-main.ts", "--help",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, IDEA_MAZE_HOME: "/dev/null/research-cli-help-invalid-workspace" },
    });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("Idea Maze hypothesis research CLI");
    expect(child.stderr).toBe("");
  });

  it("closes a live child stdin pipe when it rejects an oversized JSON request", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "research-cli-stdin-"));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(process.execPath, ["--import", "tsx", "src/idea-maze/scripts/research-cli-main.ts", "case-create"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          IDEA_MAZE_HOME: workspace,
          OPENAI_API_KEY: "",
          TAVILY_API_KEY: "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!child.stdin || !child.stdout || !child.stderr) throw new Error("CLI child pipes were not created.");
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.on("error", () => {});
      child.stdin.write(Buffer.alloc(300 * 1024, 0x78));

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CLI child did not close after stdin rejection.")), 10_000);
        child?.once("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
        child?.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      expect(exit).toEqual({ code: 65, signal: null });
      expect(Buffer.concat(stdout).toString("utf8")).toContain('"code": "VALIDATION_ERROR"');
      expect(Buffer.concat(stderr).toString("utf8")).toContain("256 KiB");
    } finally {
      child?.kill();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("runs a complete local CLI workflow through the real runtime with synthetic providers", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "research-cli-runtime-"));
    const limits: ResearchLimits = {
      maxQueries: 2,
      maxFetchedPages: 1,
      maxFollowUpRounds: 0,
      maxWallTimeSeconds: 30,
      maxModelInputTokens: 1_000,
      maxModelOutputTokens: 500,
    };
    let signalSearchStarted!: () => void;
    const blockedSearchStarted = new Promise<void>((resolve) => { signalSearchStarted = resolve; });
    let blockingSearchEntered = false;
    const providers: ResearchProviderBindings = {
      model: {
        availability: "available",
        adapter: "cli-synthetic-model",
        provider: {
          async generateJson<T>() {
            return { value: {} as T, usage: { inputTokens: 0, outputTokens: 0, costMicros: null } };
          },
        },
      },
      search: {
        availability: "available",
        adapter: "cli-synthetic-search",
        provider: {
          async search({ query, signal }) {
            if (query.includes("cli-block-synthetic")) {
              if (!blockingSearchEntered) {
                blockingSearchEntered = true;
                signalSearchStarted();
              }
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else signal.addEventListener("abort", () => resolve(), { once: true });
              });
            }
            return { results: [], requestsUsed: 1, costMicros: null };
          },
        },
      },
      originalSourceReader: {
        availability: "available",
        adapter: "cli-synthetic-reader",
        provider: {
          async fetchOriginal() {
            throw new Error("The synthetic empty-search workflow must not fetch originals.");
          },
        },
      },
    };
    const runtime = createResearchRuntime({ workspaceRoot: workspace, limits, providers });

    const invokeCli = async (argv: string[], input?: unknown) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runResearchCli(argv, {
        app: runtime.application,
        stdin: input === undefined ? emptyInput() : jsonInput(JSON.stringify(input)),
        stdout: (text) => { stdout.push(text); },
        stderr: (text) => { stderr.push(text); },
        pollIntervalMs: 50,
        waitTimeoutMs: 5_000,
        sleep: async (milliseconds) => { await new Promise((resolve) => setTimeout(resolve, Math.min(milliseconds, 10))); },
      });
      return { exitCode, stderr: stderr.join(""), value: JSON.parse(stdout.join("")) as Record<string, any> };
    };

    try {
      const capabilities = await invokeCli(["capabilities"]);
      expect(capabilities.exitCode).toBe(0);
      expect(capabilities.value.data.capabilities.search).toMatchObject({ availability: "available", adapter: "cli-synthetic-search" });

      const created = await invokeCli(["case-create"], {
        idempotencyKey: "cli-runtime-case-create-0001",
        intake: {
          ideaSummary: "A synthetic weekly reconciliation helper",
          targetUser: "Synthetic operations teams",
          problem: "Teams repeat the same reconciliation work each week.",
          proposedSolution: "A small helper for reconciliation notes.",
        },
        hypotheses: [{ claim: "Synthetic teams will use the helper each week." }],
      });
      expect(created.exitCode).toBe(0);
      const caseRecord = created.value.data.case as { caseId: string; revision: number; hypotheses: Array<{ hypothesisId: string }> };

      const fetched = await invokeCli(["case-get"], { caseId: caseRecord.caseId });
      expect(fetched.exitCode).toBe(0);
      expect(fetched.value.data.caseId).toBe(caseRecord.caseId);

      const updated = await invokeCli(["case-update"], {
        idempotencyKey: "cli-runtime-case-update-0001",
        caseId: caseRecord.caseId,
        expectedRevision: caseRecord.revision,
        intakePatch: { currentAlternatives: ["A synthetic shared sheet"] },
      });
      expect(updated.exitCode).toBe(0);
      const updatedCase = updated.value.data.case as { revision: number };

      const planDraft = (prefix: string) => ({
        queries: [
          {
            text: `${prefix} support query`,
            purpose: "problem_language" as const,
            evidenceIntent: "supporting" as const,
            hypothesisIds: [caseRecord.hypotheses[0]!.hypothesisId],
            sourceScopes: ["public_web" as const],
          },
          {
            text: `${prefix} counterevidence query`,
            purpose: "counterevidence" as const,
            evidenceIntent: "challenging" as const,
            hypothesisIds: [caseRecord.hypotheses[0]!.hypothesisId],
            sourceScopes: ["community_discussions" as const],
          },
        ],
        limits,
      });
      const planned = await invokeCli(["plan"], {
        idempotencyKey: "cli-runtime-plan-0001",
        caseId: caseRecord.caseId,
        expectedCaseRevision: updatedCase.revision,
        suppliedPlan: planDraft("cli-runtime-normal"),
      });
      expect(planned.exitCode).toBe(0);
      const plan = planned.value.data.plan as { planId: string };

      const started = await invokeCli(["start", "--poll-interval-ms", "50", "--wait-timeout-ms", "5000"], {
        idempotencyKey: "cli-runtime-run-0001",
        caseId: caseRecord.caseId,
        expectedCaseRevision: updatedCase.revision,
        planId: plan.planId,
      });
      expect(started.exitCode).toBe(0);
      expect(started.value.data.runId).toEqual(expect.any(String));
      const runId = started.value.data.runId as string;

      const statusResult = await invokeCli(["status"], { runId });
      expect(statusResult.exitCode).toBe(0);
      expect(statusResult.value.data.status).toBe("completed");
      const resultResult = await invokeCli(["result", "--format", "markdown"], { runId });
      expect(resultResult.exitCode).toBe(0);
      expect(resultResult.value.data.assessment.outcome).toBe("insufficient_evidence");
      expect(resultResult.value.data.reportMarkdown).toContain("Synthetic");

      const cancelPlan = await invokeCli(["plan"], {
        idempotencyKey: "cli-runtime-plan-cancel-0001",
        caseId: caseRecord.caseId,
        expectedCaseRevision: updatedCase.revision,
        suppliedPlan: planDraft("cli-block-synthetic"),
      });
      expect(cancelPlan.exitCode).toBe(0);
      const queued = await runtime.application.start({
        idempotencyKey: "cli-runtime-run-cancel-0001",
        caseId: caseRecord.caseId,
        expectedCaseRevision: updatedCase.revision,
        planId: cancelPlan.value.data.plan.planId as string,
      });
      expect("data" in queued).toBe(true);
      if (!("data" in queued)) return;
      await blockedSearchStarted;
      const cancelResult = await invokeCli(["cancel"], {
        runId: queued.data.runId,
        idempotencyKey: "cli-runtime-cancel-0001",
      });
      expect(cancelResult.exitCode).toBe(0);
      expect(cancelResult.value.data.cancellationRequested).toBe(true);

      let finalStatus: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const response = await runtime.application.status({ runId: queued.data.runId });
        if ("data" in response) {
          finalStatus = response.data as unknown as Record<string, unknown>;
          if (finalStatus.status === "cancelled" || finalStatus.status === "interrupted") break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(finalStatus?.status).toBe("cancelled");
    } finally {
      await runtime.shutdown();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("shows help and a safe synthetic example without invoking the application", async () => {
    const h = makeHarness();
    const exit = await runResearchCli(["--help"], h.dependencies);
    expect(exit).toBe(0);
    expect(h.stdout.join("")).toContain("demo-case-create-0001");
    expect(h.stdout.join("")).toContain("stdin");
    expect(h.app.capabilities).not.toHaveBeenCalled();
  });

  it("recognizes empty argv and help tokens without parsing or consulting a workspace", async () => {
    expect(await runResearchCli([], makeHarness().dependencies)).toBe(0);
    expect(await runResearchCli(["not-a-command", "--help"], makeHarness().dependencies)).toBe(0);
  });

  it.each([
    ["capabilities", "capabilities"],
    ["case-create", "createCase"],
    ["case-get", "getCase"],
    ["case-update", "updateCase"],
    ["plan", "plan"],
    ["status", "status"],
    ["result", "result"],
    ["cancel", "cancel"],
  ] as const)("maps %s to the shared %s application method", async (command, method) => {
    const h = makeHarness({} as Partial<ResearchApplication>, { stdin: jsonInput("{}") });
    const exit = await runResearchCli([command], h.dependencies);
    expect(exit).toBe(0);
    expect((h.app[method] as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(parsedOutput(h.stdout) as { schemaVersion: string }).toMatchObject({ schemaVersion: RESEARCH_SCHEMA_VERSION });
  });

  it("rejects unknown commands and malformed JSON without echoing submitted text", async () => {
    const argsHarness = makeHarness();
    expect(await runResearchCli(["case-create", "--no-wait"], argsHarness.dependencies)).toBe(64);
    expect(parsedOutput(argsHarness.stdout)).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { kind: "validation", issues: [{ path: "cli" }] } },
    });

    const badInput = makeHarness({}, { stdin: jsonInput('{"ideaSummary":"PRIVATE_SAMPLE_MARKER"') });
    expect(await runResearchCli(["case-create"], badInput.dependencies)).toBe(65);
    expect(parsedOutput(badInput.stdout)).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { kind: "validation", issues: [{ path: "stdin" }] } },
    });
    expect(badInput.stdout.join("")).not.toContain("PRIVATE_SAMPLE_MARKER");
    expect(badInput.stderr.join("")).not.toContain("PRIVATE_SAMPLE_MARKER");
  });

  it("maps typed application failures to stable exit codes and sanitized diagnostics", async () => {
    const failure: ResearchResponse<never> = {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      error: {
        code: "VALIDATION_ERROR",
        message: "Unsafe provider detail that should not be in diagnostics.",
        retryable: false,
        details: { kind: "validation", issues: [{ path: "caseId", code: "invalid_value" }] },
      },
    };
    const h = makeHarness({ getCase: vi.fn(async () => failure) } as unknown as Partial<ResearchApplication>, { stdin: jsonInput("{}") });
    expect(await runResearchCli(["case-get"], h.dependencies)).toBe(2);
    expect(parsedOutput(h.stdout)).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect(h.stderr.join("")).toContain("VALIDATION_ERROR");
    expect(h.stderr.join("")).not.toContain("Unsafe provider detail");
  });

  it("waits for start to reach terminal status and writes one result envelope", async () => {
    const states = [status("running"), status("completed")];
    const h = makeHarness({
      start: vi.fn(async () => response(START)),
      status: vi.fn(async () => response(states.shift() ?? status("completed"))),
    } as unknown as Partial<ResearchApplication>, {
      stdin: jsonInput('{"idempotencyKey":"cli-start-synthetic-0001","caseId":"case_cli_synthetic_01","expectedCaseRevision":1,"planId":"plan_cli_synthetic_01"}'),
      pollIntervalMs: 50,
      sleep: async () => {},
    });

    expect(await runResearchCli(["start"], h.dependencies)).toBe(0);
    expect(h.app.start).toHaveBeenCalledTimes(1);
    expect(h.app.status).toHaveBeenCalledTimes(2);
    expect(h.app.result).toHaveBeenCalledWith({ runId: START.runId, limit: 100, format: "json" });
    expect(parsedOutput(h.stdout)).toMatchObject({ data: { assessment: { outcome: "insufficient_evidence" } } });
    expect(h.stdout).toHaveLength(1);
    expect(h.stderr.join("")).toContain(START.runId);
  });

  it("passes JSON and Markdown result formats through to the same application surface", async () => {
    const json = makeHarness({}, { stdin: jsonInput('{"runId":"run_cli_synthetic_01"}') });
    const markdown = makeHarness({}, { stdin: jsonInput('{"runId":"run_cli_synthetic_01"}') });
    expect(await runResearchCli(["result"], json.dependencies)).toBe(0);
    expect(await runResearchCli(["result", "--format", "markdown"], markdown.dependencies)).toBe(0);
    const jsonData = (parsedOutput(json.stdout) as { data: ReturnType<typeof resultPage> }).data;
    const markdownData = (parsedOutput(markdown.stdout) as { data: ReturnType<typeof resultPage> }).data;
    expect(jsonData.assessment).toEqual(markdownData.assessment);
    expect(jsonData.evidence).toEqual(markdownData.evidence);
    expect(jsonData.reportMarkdown).toBeNull();
    expect(markdownData.reportMarkdown).toContain("Synthetic assessment");
  });

  it("requests cancellation on SIGINT and waits for the owned run to stop", async () => {
    const controller = new AbortController();
    let current = status("running");
    const h = makeHarness({
      status: vi.fn(async () => response(current)),
      cancel: vi.fn(async () => {
        current = status("cancelled");
        return response({ runId: START.runId, status: "cancelled", cancellationRequested: true, cancelRequestedAt: START.acceptedAt });
      }),
    } as unknown as Partial<ResearchApplication>, {
      stdin: jsonInput('{"idempotencyKey":"cli-start-synthetic-0001","caseId":"case_cli_synthetic_01","expectedCaseRevision":1,"planId":"plan_cli_synthetic_01"}'),
      signal: controller.signal,
      sleep: async () => { controller.abort(); },
      createIdempotencyKey: () => "cli-cancel-synthetic-0001",
    });

    expect(await runResearchCli(["start"], h.dependencies)).toBe(130);
    expect(h.app.cancel).toHaveBeenCalledWith({ runId: START.runId, idempotencyKey: "cli-cancel-synthetic-0001" });
    expect(h.app.status).toHaveBeenCalledTimes(2);
    expect(parsedOutput(h.stdout)).toMatchObject({ data: { evidence: [] } });
    expect(h.stderr.join("")).toContain("terminal status cancelled");
  });

  it("requests cancellation when the wait deadline elapses", async () => {
    let clock = 0;
    let current = status("running");
    const h = makeHarness({
      status: vi.fn(async () => response(current)),
      cancel: vi.fn(async () => {
        current = status("cancelled");
        return response({ runId: START.runId, status: "cancelled", cancellationRequested: true, cancelRequestedAt: START.acceptedAt });
      }),
    } as unknown as Partial<ResearchApplication>, {
      stdin: jsonInput('{"idempotencyKey":"cli-start-synthetic-0001","caseId":"case_cli_synthetic_01","expectedCaseRevision":1,"planId":"plan_cli_synthetic_01"}'),
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
      pollIntervalMs: 50,
      waitTimeoutMs: 100,
      createIdempotencyKey: () => "cli-cancel-synthetic-0001",
    });

    expect(await runResearchCli(["start"], h.dependencies)).toBe(124);
    expect(h.app.cancel).toHaveBeenCalledTimes(1);
    expect(parsedOutput(h.stdout)).toMatchObject({ data: { evidence: [] } });
    expect(h.stderr.join("")).toContain("terminal status cancelled");
  });

  it("does no application work when the CLI signal was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = makeHarness({}, {
      signal: controller.signal,
      stdin: jsonInput('{"idempotencyKey":"cli-start-synthetic-0001","caseId":"case_cli_synthetic_01","expectedCaseRevision":1,"planId":"plan_cli_synthetic_01"}'),
    });

    expect(await runResearchCli(["start"], h.dependencies)).toBe(130);
    expect(h.app.start).not.toHaveBeenCalled();
    expect(h.app.status).not.toHaveBeenCalled();
    expect(parsedOutput(h.stdout)).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });

  it("rechecks abort immediately before dispatching an application method", async () => {
    let aborted = false;
    const signal = {
      get aborted() { return aborted; },
      addEventListener: (type: string, listener: unknown) => {
        if (type === "abort") {
          queueMicrotask(() => {
            aborted = true;
            (listener as () => void)();
          });
        }
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const h = makeHarness({}, { signal });

    expect(await runResearchCli(["capabilities"], h.dependencies)).toBe(130);
    expect(h.app.capabilities).not.toHaveBeenCalled();
  });

  it("does not start a run when SIGINT lands just before the start dispatch", async () => {
    const controller = new AbortController();
    let clockCalls = 0;
    const h = makeHarness({}, {
      signal: controller.signal,
      now: () => {
        clockCalls += 1;
        if (clockCalls === 3) controller.abort();
        return 0;
      },
      stdin: jsonInput('{"idempotencyKey":"cli-start-synthetic-0001","caseId":"case_cli_synthetic_01","expectedCaseRevision":1,"planId":"plan_cli_synthetic_01"}'),
    });

    expect(await runResearchCli(["start"], h.dependencies)).toBe(130);
    expect(h.app.start).not.toHaveBeenCalled();
  });

  it("returns promptly when SIGINT arrives while stdin is pending", async () => {
    const controller = new AbortController();
    const returnIterator = vi.fn(async () => ({ done: true as const, value: undefined }));
    const stdin: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<string>>(() => {}),
          return: returnIterator,
        };
      },
    };
    const h = makeHarness({}, {
      signal: controller.signal,
      stdin,
    });
    const running = runResearchCli(["plan"], h.dependencies);
    setTimeout(() => controller.abort(), 5);

    expect(await running).toBe(130);
    expect(h.app.plan).not.toHaveBeenCalled();
    expect(returnIterator).toHaveBeenCalledTimes(1);
  });

  it("closes a still-open stdin iterator after rejecting an oversized payload", async () => {
    const returnIterator = vi.fn(async () => ({ done: true as const, value: undefined }));
    const stdin: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let emitted = false;
        return {
          next: async (): Promise<IteratorResult<string>> => {
            if (emitted) return new Promise<IteratorResult<string>>(() => {});
            emitted = true;
            return { done: false, value: "x".repeat(300 * 1024) };
          },
          return: returnIterator,
        };
      },
    };
    const h = makeHarness({}, { stdin });

    expect(await runResearchCli(["case-create"], h.dependencies)).toBe(65);
    expect(returnIterator).toHaveBeenCalledTimes(1);
    expect(h.app.createCase).not.toHaveBeenCalled();
  });

  it("returns promptly when SIGINT arrives while planning is pending", async () => {
    const controller = new AbortController();
    const h = makeHarness({
      plan: vi.fn(() => new Promise(() => {})),
    } as unknown as Partial<ResearchApplication>, {
      signal: controller.signal,
      stdin: jsonInput("{}"),
    });
    const running = runResearchCli(["plan"], h.dependencies);
    setTimeout(() => controller.abort(), 5);

    expect(await running).toBe(130);
    expect(h.app.plan).toHaveBeenCalledTimes(1);
  });

  it("lets an in-flight cancel response finish before the runtime owner can shut down", async () => {
    const controller = new AbortController();
    let resolved = false;
    const h = makeHarness({
      cancel: vi.fn(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        resolved = true;
        return response({ runId: START.runId, status: "cancelled", cancellationRequested: true, cancelRequestedAt: START.acceptedAt });
      }),
    } as unknown as Partial<ResearchApplication>, {
      signal: controller.signal,
      stdin: jsonInput('{"runId":"run_cli_synthetic_01","idempotencyKey":"cli-cancel-synthetic-0001"}'),
      cancelCleanupTimeoutMs: 100,
    });
    setTimeout(() => controller.abort(), 5);

    expect(await runResearchCli(["cancel"], h.dependencies)).toBe(0);
    expect(resolved).toBe(true);
    expect(h.app.cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds a hanging status call, explicitly cancels, and drains the owned run", async () => {
    let current = status("running");
    const h = makeHarness({
      status: vi.fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockImplementation(async () => response(current)),
      cancel: vi.fn(async () => {
        current = status("cancelled");
        return response({ runId: START.runId, status: "cancelled", cancellationRequested: true, cancelRequestedAt: START.acceptedAt });
      }),
    } as unknown as Partial<ResearchApplication>, {
      stdin: jsonInput('{"idempotencyKey":"cli-start-synthetic-0001","caseId":"case_cli_synthetic_01","expectedCaseRevision":1,"planId":"plan_cli_synthetic_01"}'),
      waitTimeoutMs: 100,
      cancelCleanupTimeoutMs: 100,
      createIdempotencyKey: () => "cli-cancel-synthetic-0001",
    });

    expect(await runResearchCli(["start"], h.dependencies)).toBe(124);
    expect(h.app.cancel).toHaveBeenCalledTimes(1);
    expect(parsedOutput(h.stdout)).toMatchObject({ data: { assessment: { outcome: "insufficient_evidence" } } });
    expect(h.stderr.join("")).toContain("terminal status cancelled");
  });

  it("bounds cancellation cleanup and reports the last observed nonterminal status honestly", async () => {
    const h = makeHarness({
      status: vi.fn(async () => response(status("running"))),
      cancel: vi.fn(() => new Promise(() => {})),
    } as unknown as Partial<ResearchApplication>, {
      stdin: jsonInput('{"idempotencyKey":"cli-start-synthetic-0001","caseId":"case_cli_synthetic_01","expectedCaseRevision":1,"planId":"plan_cli_synthetic_01"}'),
      waitTimeoutMs: 100,
      cancelCleanupTimeoutMs: 50,
      createIdempotencyKey: () => "cli-cancel-synthetic-0001",
    });

    expect(await runResearchCli(["start"], h.dependencies)).toBe(124);
    expect(parsedOutput(h.stdout)).toMatchObject({ data: { status: "running" } });
    expect(h.stderr.join("")).toContain("Cleanup incomplete: last observed status running");
    expect(h.stderr.join("")).toContain("no successful cancellation response was received");
    expect(h.stderr.join("")).not.toContain("terminal status running");
  });

  it("bounds a hanging result page after the run completes", async () => {
    const h = makeHarness({
      status: vi.fn(async () => response(status("completed"))),
      result: vi.fn(() => new Promise(() => {})),
    } as unknown as Partial<ResearchApplication>, {
      stdin: jsonInput('{"idempotencyKey":"cli-start-synthetic-0001","caseId":"case_cli_synthetic_01","expectedCaseRevision":1,"planId":"plan_cli_synthetic_01"}'),
      waitTimeoutMs: 100,
    });

    expect(await runResearchCli(["start"], h.dependencies)).toBe(124);
    expect(parsedOutput(h.stdout)).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
  });

  it("does not skip explicit cancellation when injected sleep rejects on SIGINT", async () => {
    const controller = new AbortController();
    let current = status("running");
    const h = makeHarness({
      status: vi.fn(async () => response(current)),
      cancel: vi.fn(async () => {
        current = status("cancelled");
        return response({ runId: START.runId, status: "cancelled", cancellationRequested: true, cancelRequestedAt: START.acceptedAt });
      }),
    } as unknown as Partial<ResearchApplication>, {
      stdin: jsonInput('{"idempotencyKey":"cli-start-synthetic-0001","caseId":"case_cli_synthetic_01","expectedCaseRevision":1,"planId":"plan_cli_synthetic_01"}'),
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
        throw new Error("synthetic aborted sleeper");
      },
      createIdempotencyKey: () => "cli-cancel-synthetic-0001",
    });

    expect(await runResearchCli(["start"], h.dependencies)).toBe(130);
    expect(h.app.cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid UTF-8 without replacing bytes inside a JSON idea", async () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    const h = makeHarness({}, { stdin: (async function* () { yield bytes; })() });

    expect(await runResearchCli(["case-create"], h.dependencies)).toBe(65);
    expect(parsedOutput(h.stdout)).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { issues: [{ path: "stdin" }] } },
    });
    expect(h.app.createCase).not.toHaveBeenCalled();
  });

  it("rejects mixed string/byte chunks that split a UTF-8 character", async () => {
    const h = makeHarness({}, {
      stdin: (async function* () {
        yield new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3]);
        yield "x";
        yield new Uint8Array([0x22, 0x7d]);
      })(),
    });

    expect(await runResearchCli(["case-create"], h.dependencies)).toBe(65);
    expect(h.stderr.join("")).toContain("valid UTF-8");
    expect(h.app.createCase).not.toHaveBeenCalled();
  });

  it("rejects lone UTF-16 surrogates in string chunks instead of encoding replacement bytes", async () => {
    const h = makeHarness({}, { stdin: jsonInput('{"ideaSummary":"\ud800"}') });

    expect(await runResearchCli(["case-create"], h.dependencies)).toBe(65);
    expect(parsedOutput(h.stdout)).toMatchObject({
      error: { code: "VALIDATION_ERROR", details: { issues: [{ path: "stdin" }] } },
    });
    expect(h.app.createCase).not.toHaveBeenCalled();
  });
});
