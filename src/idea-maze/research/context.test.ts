import Database from "better-sqlite3";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResearchLimits } from "./contracts.js";
import {
  noResearchProviders,
  type ModelProvider,
  type ResearchProviderBindings,
} from "./ports.js";

const TEST_LIMITS: ResearchLimits = {
  maxQueries: 8,
  maxFetchedPages: 12,
  maxFollowUpRounds: 1,
  maxWallTimeSeconds: 120,
  maxModelInputTokens: 4_000,
  maxModelOutputTokens: 2_000,
};

const temporaryRoots: string[] = [];
const contexts: Array<{ dispose(): void }> = [];
const databases: Database.Database[] = [];

function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `research-context-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function makeDatabase(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  return db;
}

function baseOptions(root: string, connection: Database.Database, workspaceKey: string, providers = noResearchProviders()) {
  const serviceLifetime = new AbortController();
  return {
    database: { ownership: "borrowed" as const, connection },
    paths: { workspaceRoot: root, databaseFile: null },
    workspaceKey,
    clock: { now: () => new Date("2026-01-02T03:04:05.000Z") },
    logger: { log: vi.fn() },
    providers,
    serviceLifetimeSignal: serviceLifetime.signal,
    limits: TEST_LIMITS,
    idFactory: (kind: string) => `${workspaceKey}-${kind}-1`,
    serviceLifetime,
  };
}

afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose();
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("explicit research context", () => {
  it("imports without running a CLI or making network calls", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () => {
      throw new Error("network access during import");
    });
    const logSpy = vi.spyOn(console, "log");
    const exitSpy = vi.spyOn(process, "exit");
    const signalListenerCount = process.listenerCount("SIGINT");
    vi.stubGlobal("fetch", fetchMock);

    await import("./context.js");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(process.listenerCount("SIGINT")).toBe(signalListenerCount);
  });

  it("keeps two workspaces, their SQLite state, providers, paths, and IDs isolated", async () => {
    const { createResearchContext } = await import("./context.js");
    const rootA = makeRoot("a");
    const rootB = makeRoot("b");
    const dbA = makeDatabase();
    const dbB = makeDatabase();
    const modelA: ModelProvider = {
      async generateJson<T>() {
        return { value: { workspace: "a" } as T, usage: { inputTokens: null, outputTokens: null, costMicros: null } };
      },
    };
    const modelB: ModelProvider = {
      async generateJson<T>() {
        return { value: { workspace: "b" } as T, usage: { inputTokens: 1, outputTokens: 2, costMicros: 3 } };
      },
    };
    const providersA: ResearchProviderBindings = {
      ...noResearchProviders(),
      model: { availability: "available", adapter: "mock-a", provider: modelA },
    };
    const providersB: ResearchProviderBindings = {
      ...noResearchProviders(),
      model: { availability: "available", adapter: "mock-b", provider: modelB },
    };
    dbA.exec("CREATE TABLE isolated_state (value TEXT NOT NULL); INSERT INTO isolated_state VALUES ('workspace-a');");
    dbB.exec("CREATE TABLE isolated_state (value TEXT NOT NULL); INSERT INTO isolated_state VALUES ('workspace-b');");

    const contextA = createResearchContext(baseOptions(rootA, dbA, "workspace-a", providersA));
    const contextB = createResearchContext(baseOptions(rootB, dbB, "workspace-b", providersB));
    contexts.push(contextA, contextB);

    expect(contextA.paths.workspaceRoot).not.toBe(contextB.paths.workspaceRoot);
    expect(contextA.paths.artifactsDirectory).not.toBe(contextB.paths.artifactsDirectory);
    expect(contextA.workspaceKey).not.toBe(contextB.workspaceKey);
    expect(contextA.db).not.toBe(contextB.db);
    expect(contextA.db.prepare("SELECT value FROM isolated_state").get()).toEqual({ value: "workspace-a" });
    expect(contextB.db.prepare("SELECT value FROM isolated_state").get()).toEqual({ value: "workspace-b" });
    expect(contextA.providers.model.provider).toBe(modelA);
    expect(contextB.providers.model.provider).toBe(modelB);
    providersA.model.availability = "not_configured";
    expect(contextA.providers.model.availability).toBe("available");
    expect(Object.isFrozen(contextA.providers.model)).toBe(true);
    expect(contextA.idFactory("case")).toBe("workspace-a-case-1");
    expect(contextB.idFactory("case")).toBe("workspace-b-case-1");
    expect(Object.isFrozen(contextA.limits)).toBe(true);
    expect(contextA.providers.search.availability).toBe("not_configured");
  });

  it("keeps service lifetime separate from per-run cancellation", async () => {
    const { createResearchContext } = await import("./context.js");
    const root = makeRoot("lifetime");
    const db = makeDatabase();
    const options = baseOptions(root, db, "lifetime-workspace");
    const context = createResearchContext(options);
    contexts.push(context);
    const runCancellation = new AbortController();
    const scope = context.createProviderSignal(runCancellation.signal);

    runCancellation.abort();
    expect(scope.signal.aborted).toBe(true);
    expect(context.serviceSignal.aborted).toBe(false);

    const operationScope = context.createProviderSignal();
    context.shutdown();
    expect(context.serviceSignal.aborted).toBe(true);
    expect(operationScope.signal.aborted).toBe(true);
    expect(db.open).toBe(true);
    scope.dispose();
    operationScope.dispose();
  });

  it("does not close a borrowed database when disposed", async () => {
    const { createResearchContext } = await import("./context.js");
    const root = makeRoot("borrowed");
    const db = makeDatabase();
    const context = createResearchContext(baseOptions(root, db, "borrowed-workspace"));
    contexts.push(context);

    context.dispose();
    expect(context.isDisposed).toBe(true);
    expect(db.open).toBe(true);
    db.exec("CREATE TABLE still_usable (value INTEGER); INSERT INTO still_usable VALUES (7);");
    expect(db.prepare("SELECT value FROM still_usable").pluck().get()).toBe(7);
  });

  it("closes an owned database exactly once on disposal", async () => {
    const { createResearchContext } = await import("./context.js");
    const root = makeRoot("owned");
    const options = {
      ...baseOptions(root, makeDatabase(), "owned-workspace"),
      database: { ownership: "owned" as const },
      paths: { workspaceRoot: root, databaseFile: "data/research.sqlite" },
    };
    const context = createResearchContext(options);
    contexts.push(context);
    const closeSpy = vi.spyOn(context.db, "close");

    context.dispose();
    context.dispose();

    expect(context.databaseOwnership).toBe("owned");
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(context.db.open).toBe(false);
  });

  it("closes an owned database if a shutdown logger throws", async () => {
    const { createResearchContext } = await import("./context.js");
    const root = makeRoot("owned-logger");
    const options = {
      ...baseOptions(root, makeDatabase(), "owned-logger-workspace"),
      database: { ownership: "owned" as const },
      paths: { workspaceRoot: root, databaseFile: "data/research.sqlite" },
      logger: { log: vi.fn(() => { throw new Error("test logger failure"); }) },
    };
    const context = createResearchContext(options);
    contexts.push(context);
    const closeSpy = vi.spyOn(context.db, "close");

    expect(() => context.dispose()).toThrow("test logger failure");
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(context.db.open).toBe(false);
  });

  it("rejects traversal and symlink escapes while allowing offline contexts", async () => {
    const { createResearchContext, resolveResearchPaths } = await import("./context.js");
    const root = makeRoot("paths");
    const outside = makeRoot("outside");
    symlinkSync(outside, join(root, "external"));
    symlinkSync(join(outside, "missing.sqlite"), join(root, "dangling.sqlite"));
    expect(() => resolveResearchPaths({ workspaceRoot: root, databaseFile: "../outside.sqlite" })).toThrow();
    expect(() => resolveResearchPaths({ workspaceRoot: root, artifactsDirectory: "external/results" })).toThrow();
    expect(() => resolveResearchPaths({ workspaceRoot: root, databaseFile: "dangling.sqlite" })).toThrow();

    const db = makeDatabase();
    const context = createResearchContext(baseOptions(root, db, "offline-workspace"));
    contexts.push(context);
    expect(context.providers.model.availability).toBe("not_configured");
    expect(context.providers.search.availability).toBe("not_configured");
    expect(context.paths.databaseFile).toBeNull();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
  });

  it("rejects limits above the frozen contract ceilings", async () => {
    const { createResearchContext } = await import("./context.js");
    const root = makeRoot("limits");
    const db = makeDatabase();
    const options = baseOptions(root, db, "limited-workspace");
    expect(() => createResearchContext({
      ...options,
      limits: { ...TEST_LIMITS, maxQueries: 41 },
    })).toThrow(/maxQueries/);
    expect(db.open).toBe(true);
  });
});
