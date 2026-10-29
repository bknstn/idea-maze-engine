import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { afterEach, describe, expect, it } from "vitest";

import { createResearchRuntime, type ResearchRuntime } from "./runtime.js";
import { noResearchProviders, unavailableProvider, type ResearchProviderBindings, type SearchProvider } from "./ports.js";
import type { ResearchLimits, ResearchResponse, ResearchRun } from "./contracts.js";

const TEST_LIMITS: ResearchLimits = {
  maxQueries: 2,
  maxFetchedPages: 1,
  maxFollowUpRounds: 0,
  maxWallTimeSeconds: 30,
  maxModelInputTokens: 1_000,
  maxModelOutputTokens: 1_000,
};

let runtimes: ResearchRuntime[] = [];
let roots: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes) await runtime.shutdown();
  runtimes = [];
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("research runtime composition", () => {
  it("opens and migrates an owned workspace synchronously, then closes it after shutdown", async () => {
    const root = makeRoot();
    const runtime = createResearchRuntime({
      workspaceRoot: root,
      environment: { IDEA_MAZE_HOME: root },
      providers: noResearchProviders(),
    });
    runtimes.push(runtime);

    expect(runtime.context.databaseOwnership).toBe("owned");
    expect(runtime.context.db.open).toBe(true);
    expect(runtime.context.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='research_runs'").get()).toEqual({
      name: "research_runs",
    });
    const capabilities = await runtime.application.capabilities();
    expect("data" in capabilities && capabilities.data.limits.maxQueries).toBeGreaterThan(0);
    expect("data" in capabilities && capabilities.data.capabilities.search.availability).toBe("not_configured");

    await runtime.shutdown();
    expect(runtime.context.db.open).toBe(false);
  });

  it("binds separate roots to isolated owned stores", async () => {
    const firstRoot = makeRoot();
    const secondRoot = makeRoot();
    const first = createResearchRuntime({ workspaceRoot: firstRoot, providers: noResearchProviders() });
    const second = createResearchRuntime({ workspaceRoot: secondRoot, providers: noResearchProviders() });
    runtimes.push(first, second);

    const created = await first.application.createCase({
      idempotencyKey: "runtime-isolation-case",
      intake: {
        ideaSummary: "A synthetic workspace-specific idea",
        targetUser: "Synthetic users",
        problem: "A synthetic workflow problem",
        proposedSolution: "A synthetic helper",
      },
      hypotheses: [{ claim: "Synthetic users will try the helper." }],
    });
    expect("data" in created).toBe(true);
    const missing = await second.application.getCase({ caseId: "case_missing_from_other_workspace" });
    expect("error" in missing && missing.error.code).toBe("NOT_FOUND");
    expect(first.context.workspaceKey).not.toBe(second.context.workspaceKey);
  });

  it("uses one canonical workspace key across symlink aliases and drains runs if shutdown logging throws", async () => {
    const container = makeRoot();
    const targetRoot = path.join(container, "real-workspace");
    const aliasRoot = path.join(container, "workspace-alias");
    fs.mkdirSync(targetRoot);
    fs.symlinkSync(targetRoot, aliasRoot, "dir");

    let markSearchStarted: (() => void) | undefined;
    const searchStarted = new Promise<void>((resolve) => { markSearchStarted = resolve; });
    const providers: ResearchProviderBindings = {
      model: unavailableProvider("not_configured"),
      originalSourceReader: unavailableProvider("not_configured"),
      search: {
        availability: "available",
        adapter: "synthetic-search",
        provider: blockingSearch(() => markSearchStarted?.()),
      },
    };
    const first = createResearchRuntime({
      workspaceRoot: targetRoot,
      providers,
      limits: TEST_LIMITS,
      logger: { log() { throw new Error("Synthetic logger failure"); } },
    });
    const second = createResearchRuntime({
      workspaceRoot: aliasRoot,
      providers: noResearchProviders(),
      limits: TEST_LIMITS,
    });
    runtimes.push(first, second);

    expect(first.context.workspaceKey).toBe(second.context.workspaceKey);
    expect(first.context.paths.databaseFile).toBe(second.context.paths.databaseFile);
    const started = await startSyntheticRun(first);
    await waitFor(searchStarted, 2_000);
    const secondStart = await second.application.start({
      idempotencyKey: "start-through-workspace-alias",
      caseId: started.caseId,
      expectedCaseRevision: started.caseRevision,
      planId: started.planId,
    });
    expect("error" in secondStart && secondStart.error.code).toBe("BUSY");

    await expect(first.shutdown()).resolves.toBeUndefined();
    expect(first.context.db.open).toBe(false);
    const statusDb = new Database(first.context.paths.databaseFile!, { readonly: true });
    try {
      const row = statusDb.prepare("SELECT status FROM research_runs WHERE run_id = ?").get(started.runId) as { status: ResearchRun["status"] };
      expect(row.status).toBe("interrupted");
    } finally {
      statusDb.close();
    }
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "idea-maze-runtime-"));
  roots.push(root);
  return root;
}

async function startSyntheticRun(runtime: ResearchRuntime): Promise<{
  caseId: string;
  caseRevision: number;
  planId: string;
  runId: string;
}> {
  const created = data(await runtime.application.createCase({
    idempotencyKey: "runtime-shutdown-case",
    intake: {
      ideaSummary: "A synthetic coordination board",
      targetUser: "Synthetic teams",
      problem: "Synthetic tasks become stale",
      proposedSolution: "A synthetic task board",
    },
    hypotheses: [{ claim: "Synthetic teams will use a task board." }],
  }));
  const hypothesisId = created.case.hypotheses[0]!.hypothesisId;
  const planned = data(await runtime.application.plan({
    idempotencyKey: "runtime-shutdown-plan",
    caseId: created.case.caseId,
    expectedCaseRevision: created.case.revision,
    suppliedPlan: {
      queries: [
        { text: "synthetic support query", purpose: "problem_language", evidenceIntent: "supporting", hypothesisIds: [hypothesisId], sourceScopes: ["public_web"] },
        { text: "synthetic challenge query", purpose: "counterevidence", evidenceIntent: "challenging", hypothesisIds: [hypothesisId], sourceScopes: ["public_web"] },
      ],
      limits: TEST_LIMITS,
    },
  }));
  if (!planned.plan) throw new Error("Synthetic runtime plan was not ready.");
  const run = data(await runtime.application.start({
    idempotencyKey: "runtime-shutdown-run",
    caseId: created.case.caseId,
    expectedCaseRevision: created.case.revision,
    planId: planned.plan.planId,
  }));
  return {
    caseId: created.case.caseId,
    caseRevision: created.case.revision,
    planId: planned.plan.planId,
    runId: run.runId,
  };
}

function data<T>(response: ResearchResponse<T>): T {
  if (!("data" in response)) throw new Error(`Synthetic runtime operation failed: ${response.error.code}`);
  return response.data;
}

function blockingSearch(onStart: () => void): SearchProvider {
  return {
    search({ signal }) {
      onStart();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
}

async function waitFor(promise: Promise<void>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for synthetic run dispatch.")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
