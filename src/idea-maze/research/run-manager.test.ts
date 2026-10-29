import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  ResearchAssessment,
  ResearchLimits,
  ResearchResponse,
  StartRunInput,
  StartRunResult,
} from './contracts.ts';
import type { ResearchRunStepExecutor, ResearchStepAdapter } from './run-step-executor.ts';
import { createResearchRunStepExecutor } from './run-step-executor.ts';
import { createResearchRunManager } from './run-manager.ts';
import { createResearchRepositories, type ResearchRepositories } from './repositories.ts';
import { initSchema } from '../scripts/lib/schema.ts';

const databases: Database.Database[] = [];
const scratchDirectories: string[] = [];
const childProcesses: ChildProcessWithoutNullStreams[] = [];

const limits: ResearchLimits = {
  maxQueries: 4,
  maxFetchedPages: 4,
  maxFollowUpRounds: 1,
  maxWallTimeSeconds: 5,
  maxModelInputTokens: 1000,
  maxModelOutputTokens: 500,
};

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await once(child, 'close').catch(() => undefined);
  }
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  for (const directory of scratchDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function database(filename = ':memory:'): Database.Database {
  const db = new Database(filename);
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  initSchema(db);
  return db;
}

function makeRepositories(db: Database.Database, clock: { now(): Date }): ResearchRepositories {
  return createResearchRepositories({ db, workspaceKey: 'synthetic-workspace', clock: () => clock.now() });
}

function seedRunnable(repositories: ResearchRepositories, planLimits: ResearchLimits = limits) {
  const caseRevision = repositories.cases.create({
    intake: { ideaSummary: 'A synthetic workflow helper', problem: 'A recurring manual task takes time.' },
    hypotheses: [{ claim: 'Small teams repeat this task every week.' }],
  });
  const plan = repositories.plans.create({
    caseId: caseRevision.caseId,
    caseRevision: caseRevision.revision,
    queries: [{
      text: 'How do small teams handle recurring manual tasks?',
      purpose: 'problem_language',
      evidenceIntent: 'supporting',
      hypothesisIds: [caseRevision.hypothesisRevisions[0].hypothesisId],
      sourceScopes: ['public_web'],
    }],
    limits: planLimits,
  });
  return { caseRevision, plan };
}

function assessmentFor(run: Parameters<ResearchStepAdapter['execute']>[0]['run']): ResearchAssessment {
  return {
    outcome: 'insufficient_evidence',
    summary: 'The synthetic run did not establish enough evidence.',
    rationale: 'This fixture only exercises durable coordination.',
    claims: [],
    coverageGaps: [],
    nextExperiment: 'Collect additional original sources.',
  };
}

function adapter(execute: ResearchStepAdapter['execute']): ResearchStepAdapter {
  return { availability: 'available', providerVersion: 'synthetic-step-v1', execute };
}

function executor(overrides: Partial<Record<'search' | 'fetch_originals' | 'map_evidence' | 'assess', ResearchStepAdapter>> = {}) {
  const empty = adapter(async () => ({}));
  return createResearchRunStepExecutor({
    adapters: {
      search: overrides.search ?? empty,
      fetch_originals: overrides.fetch_originals ?? empty,
      map_evidence: overrides.map_evidence ?? empty,
      assess: overrides.assess ?? adapter(async ({ run }) => ({ assessment: assessmentFor(run) })),
    },
  });
}

function manager(
  repositories: ResearchRepositories,
  runExecutor = executor(),
  clock: { now(): Date } = { now: () => new Date('2026-01-01T00:00:00.000Z') },
  options: { signal?: AbortSignal; limits?: ResearchLimits; leaseTtlMilliseconds?: number; renewalIntervalMilliseconds?: number } = {},
) {
  return createResearchRunManager({
    repositories,
    executor: runExecutor,
    clock,
    serviceSignal: options.signal ?? new AbortController().signal,
    limits: options.limits ?? limits,
    ownerInstanceId: `synthetic-owner-${Math.random().toString(16).slice(2)}`,
    leaseTtlMilliseconds: options.leaseTtlMilliseconds ?? 30_000,
    renewalIntervalMilliseconds: options.renewalIntervalMilliseconds ?? 500,
    maintenanceIntervalMilliseconds: 50,
  });
}

function startInput(caseId: string, planId: string, key = 'start-key-00000001'): StartRunInput {
  return { idempotencyKey: key, caseId, expectedCaseRevision: 1, planId };
}

function successful<T>(response: ResearchResponse<T>): T {
  if ('error' in response) throw new Error(`Expected success, got ${response.error.code}`);
  return response.data;
}

async function waitFor<T>(read: () => T, predicate: (value: T) => boolean, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for synthetic run state');
}

function countRows(db: Database.Database, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function spawnCoordinationWorker(mode: 'owner' | 'contender', databaseFile: string, caseId: string, planId: string) {
  const fixture = fileURLToPath(new URL('./fixtures/run-coordination-worker.ts', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', fixture, mode, databaseFile, caseId, planId], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childProcesses.push(child);
  let buffered = '';
  const queued: string[] = [];
  const pending: Array<{ prefix: string; resolve(line: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }> = [];
  child.stdout.on('data', (chunk: Buffer | string) => {
    buffered += String(chunk);
    while (buffered.includes('\n')) {
      const newline = buffered.indexOf('\n');
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      const index = pending.findIndex((item) => line.startsWith(item.prefix));
      if (index >= 0) {
        const waiter = pending.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(line);
      } else queued.push(line);
    }
  });
  return {
    child,
    nextLine(prefix: string, timeoutMs = 4_000): Promise<string> {
      const index = queued.findIndex((line) => line.startsWith(prefix));
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const pendingIndex = pending.findIndex((item) => item.resolve === resolve);
          if (pendingIndex >= 0) pending.splice(pendingIndex, 1);
          reject(new Error(`Timed out waiting for worker output ${prefix}`));
        }, timeoutMs);
        pending.push({ prefix, resolve, reject, timer });
      });
    },
  };
}

describe('research run manager', () => {
  it('returns queued promptly, replays canonical starts without rerunning steps, and rejects key conflicts', async () => {
    const db = database();
    const repositories = makeRepositories(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { caseRevision, plan } = seedRunnable(repositories);
    let stepCalls = 0;
    let releaseSearch!: () => void;
    const searchGate = new Promise<void>((resolve) => { releaseSearch = resolve; });
    const runExecutor = executor({
      search: adapter(async () => {
        stepCalls += 1;
        await searchGate;
        return {};
      }),
      fetch_originals: adapter(async () => { stepCalls += 1; return {}; }),
      map_evidence: adapter(async () => { stepCalls += 1; return {}; }),
      assess: adapter(async ({ run }) => { stepCalls += 1; return { assessment: assessmentFor(run) }; }),
    });
    const service = manager(repositories, runExecutor);
    const input = startInput(caseRevision.caseId, plan.planId);

    const first = successful(await service.start(input));
    expect(first.status).toBe('queued');
    const replay = successful(await service.start(input));
    expect(replay).toEqual(first);
    const conflict = await service.start({ ...input, planId: 'different-plan' });
    expect(conflict).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
    repositories.cases.update({ caseId: caseRevision.caseId, expectedRevision: 1, intakePatch: { targetUser: 'Synthetic teams' } });
    releaseSearch();

    const final = await waitFor(
      () => repositories.runs.get(first.runId),
      (run) => run?.status === 'completed',
    );
    expect(final?.snapshot.caseRevision).toEqual(caseRevision);
    expect(repositories.cases.get(caseRevision.caseId)?.revision).toBe(2);
    expect(final?.assessment).toEqual(assessmentFor(final!));
    expect(stepCalls).toBe(4);
    expect(countRows(db, 'research_runs')).toBe(1);
    await service.shutdown();
  });

  it('creates no run or receipt when the lease is busy or the workspace budget rejects a plan', async () => {
    const db = database();
    const repositories = makeRepositories(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { caseRevision, plan } = seedRunnable(repositories);
    let entered!: () => void;
    const enteredStep = new Promise<void>((resolve) => { entered = resolve; });
    const hanging = executor({
      search: adapter(async ({ callProvider }) => {
        entered();
        await callProvider(() => new Promise<never>(() => undefined), 'search');
        return {};
      }),
    });
    const owner = manager(repositories, hanging, undefined, { leaseTtlMilliseconds: 3_000, renewalIntervalMilliseconds: 100 });
    const contender = manager(repositories, executor());
    const first = successful(await owner.start(startInput(caseRevision.caseId, plan.planId, 'owner-start-0001')));
    await enteredStep;
    const busy = await contender.start(startInput(caseRevision.caseId, plan.planId, 'busy-start-0001'));
    expect(busy).toMatchObject({ error: { code: 'BUSY', details: { kind: 'busy', activeRunId: first.runId } } });
    expect(countRows(db, 'research_runs')).toBe(1);
    expect(countRows(db, 'research_idempotency_receipts')).toBe(1);
    await owner.cancel({ runId: first.runId, idempotencyKey: 'cancel-owner-0001' });
    await waitFor(() => repositories.runs.get(first.runId)?.status, (status) => status === 'cancelled');
    await Promise.all([owner.shutdown(), contender.shutdown()]);

    const smallLimits = { ...limits, maxQueries: 1 };
    const oversized = seedRunnable(repositories, { ...limits, maxQueries: 2 });
    const constrained = manager(repositories, executor(), undefined, { limits: smallLimits });
    const beforeRuns = countRows(db, 'research_runs');
    const beforeReceipts = countRows(db, 'research_idempotency_receipts');
    const rejected = await constrained.start(startInput(oversized.caseRevision.caseId, oversized.plan.planId, 'over-limit-start-1'));
    expect(rejected).toMatchObject({ error: { code: 'LIMIT_EXCEEDED', details: { kind: 'limit_exceeded', limitName: 'maxQueries' } } });
    expect(countRows(db, 'research_runs')).toBe(beforeRuns);
    expect(countRows(db, 'research_idempotency_receipts')).toBe(beforeReceipts);
    await constrained.shutdown();
  });

  it('returns a completed insufficient-evidence assessment when collection is unavailable', async () => {
    const db = database();
    const repositories = makeRepositories(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { caseRevision, plan } = seedRunnable(repositories);
    const unavailable = createResearchRunStepExecutor({ adapters: {} });
    const service = manager(repositories, unavailable);
    const started = successful(await service.start(startInput(caseRevision.caseId, plan.planId)));
    const final = await waitFor(() => repositories.runs.get(started.runId), (run) => run?.status === 'completed');
    expect(final).toMatchObject({
      stoppingReason: 'provider_unavailable',
      assessment: { outcome: 'insufficient_evidence' },
    });
    expect(final?.coverageGaps).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'provider_unavailable' })]));
    await service.shutdown();
  });

  it('completes a partial assessment with a budget gap and preserves the limit stopping reason', async () => {
    const db = database();
    const repositories = makeRepositories(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { caseRevision, plan } = seedRunnable(repositories);
    const budgetGap = {
      reason: 'budget_exhausted' as const,
      detail: 'The remaining model budget was reserved for the final deterministic assessment.',
      queryId: null,
      hypothesisId: null,
    };
    const runExecutor = executor({
      search: adapter(async ({ run }) => ({ evidence: [{
        kind: 'search_snippet',
        snippetId: 'snippet_partial_budget',
        queryId: run.snapshot.plan.queries[0].queryId,
        sourceUrl: 'https://example.test/synthetic-budget-source',
        text: 'Synthetic partial discovery evidence remains available for assessment.',
        assessmentEligible: false,
      }] })),
      map_evidence: adapter(async () => ({ coverageGaps: [budgetGap] })),
      assess: adapter(async ({ run }) => ({ assessment: {
        ...assessmentFor(run),
        coverageGaps: [budgetGap],
      } })),
    });
    const service = manager(repositories, runExecutor);
    const started = successful(await service.start(startInput(caseRevision.caseId, plan.planId)));
    const final = await waitFor(() => repositories.runs.get(started.runId), (run) => run?.status === 'completed');
    expect(final).toMatchObject({
      status: 'completed',
      stoppingReason: 'limit_reached',
      assessment: { outcome: 'insufficient_evidence', coverageGaps: [budgetGap] },
      coverageGaps: [budgetGap],
    });
    expect(repositories.evidence.list(started.runId)).toHaveLength(1);
    await service.shutdown();
  });

  it('cancels a remote in-flight adapter, keeps completed partial evidence, and ignores unrelated client aborts', async () => {
    const db = database();
    const repositories = makeRepositories(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { caseRevision, plan } = seedRunnable(repositories);
    let fetchStarted!: () => void;
    const fetching = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const runExecutor = executor({
      search: adapter(async ({ run }) => ({ evidence: [{
        kind: 'search_snippet',
        snippetId: 'snippet_partial_1',
        queryId: run.snapshot.plan.queries[0].queryId,
        sourceUrl: 'https://example.test/synthetic-source',
        text: 'Synthetic discovery text remains after cancellation.',
        assessmentEligible: false,
      }] })),
      fetch_originals: adapter(async ({ callProvider }) => {
        fetchStarted();
        await callProvider(() => new Promise<never>(() => undefined), 'original_source_fetch');
        return {};
      }),
    });
    const service = manager(repositories, runExecutor, undefined, { leaseTtlMilliseconds: 3_000, renewalIntervalMilliseconds: 100 });
    const clientSignal = new AbortController();
    const request = startInput(caseRevision.caseId, plan.planId);
    const invalidRequest = await service.start({ ...request, signal: clientSignal.signal } as StartRunInput);
    expect(invalidRequest).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const started = successful(await service.start(request));
    await fetching;
    clientSignal.abort(); // No run method accepts an HTTP/client signal.
    expect(repositories.runs.get(started.runId)?.cancelRequestedAt).toBeNull();
    const cancelResult = successful(await service.cancel({ runId: started.runId, idempotencyKey: 'cancel-explicit-1' }));
    expect(cancelResult.cancellationRequested).toBe(true);
    const final = await waitFor(() => repositories.runs.get(started.runId), (run) => run?.status === 'cancelled');
    expect(repositories.evidence.list(started.runId)).toHaveLength(1);
    expect(final?.coverageGaps).toContainEqual(expect.objectContaining({ reason: 'cancelled' }));
    await service.shutdown();
  });

  it('persists a completed provider chunk after cancellation and blocks the next dispatch', async () => {
    const db = database();
    const repositories = makeRepositories(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { caseRevision, plan } = seedRunnable(repositories);
    let providerCalls = 0;
    const runExecutor = executor({
      search: adapter(async ({ run, callProvider, withWrite }) => {
        await callProvider(async () => {
          providerCalls += 1;
          return { requestsUsed: 1 };
        }, 'search');
        repositories.runs.requestCancellation(run.runId, '2026-01-01T00:00:01.000Z');
        withWrite((lease) => repositories.evidence.save(run.runId, {
          kind: 'search_snippet',
          snippetId: 'snippet_after_cancel_request',
          queryId: run.snapshot.plan.queries[0].queryId,
          sourceUrl: 'https://example.test/synthetic-completed-chunk',
          text: 'A completed synthetic chunk is retained after cancellation.',
          assessmentEligible: false,
        }, lease));
        await callProvider(async () => {
          providerCalls += 1;
          return { requestsUsed: 1 };
        }, 'search');
        return {};
      }),
    });
    const service = manager(repositories, runExecutor);
    const started = successful(await service.start(startInput(caseRevision.caseId, plan.planId)));
    await waitFor(() => repositories.runs.get(started.runId)?.status, (status) => status === 'cancelled');
    expect(providerCalls).toBe(1);
    expect(repositories.evidence.list(started.runId)).toHaveLength(1);
    expect(repositories.runs.get(started.runId)?.status).toBe('cancelled');
    await service.shutdown();
  });

  it('cancellation wins a concurrent step failure or shutdown and the lease is released only after terminal state', async () => {
    const db = database();
    const repositories = makeRepositories(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { caseRevision, plan } = seedRunnable(repositories);
    const failingExecutor: ResearchRunStepExecutor = {
      async executeStep({ run }) {
        repositories.runs.requestCancellation(run.runId, '2026-01-01T00:00:01.000Z');
        return {
          status: 'failed',
          providerAvailability: 'available',
          failureCode: 'INTERNAL_ERROR',
          output: {},
        };
      },
    };
    const service = manager(repositories, failingExecutor);
    const started = successful(await service.start(startInput(caseRevision.caseId, plan.planId)));
    const cancelled = await waitFor(() => repositories.runs.get(started.runId), (run) => run?.status === 'cancelled');
    expect(cancelled?.stoppingReason).toBe('cancelled');
    const leaseRow = db.prepare('SELECT owner_instance_id FROM research_workspace_leases WHERE workspace_key = ?')
      .get('synthetic-workspace') as { owner_instance_id: string | null };
    expect(leaseRow.owner_instance_id).toBeNull();
    await service.shutdown();

    const second = seedRunnable(repositories);
    const serviceWithShutdownRace = manager(repositories, executor());
    const queued = successful(await serviceWithShutdownRace.start(startInput(second.caseRevision.caseId, second.plan.planId, 'shutdown-cancel-0001')));
    await serviceWithShutdownRace.cancel({ runId: queued.runId, idempotencyKey: 'shutdown-cancel-request-1' });
    await serviceWithShutdownRace.shutdown();
    expect(repositories.runs.get(queued.runId)).toMatchObject({ status: 'cancelled', stoppingReason: 'cancelled' });
    const released = db.prepare('SELECT owner_instance_id FROM research_workspace_leases WHERE workspace_key = ?')
      .get('synthetic-workspace') as { owner_instance_id: string | null };
    expect(released.owner_instance_id).toBeNull();
  });

  it('reserves the remaining model token budget before dispatching concurrent calls', async () => {
    const db = database();
    const repositories = makeRepositories(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { caseRevision, plan } = seedRunnable(repositories);
    let firstBudget: { maxInputTokens: number; maxOutputTokens: number } | null = null;
    let firstSignal: AbortSignal | null = null;
    let firstDispatches = 0;
    let secondDispatches = 0;
    let firstStarted!: () => void;
    const firstCallStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const runExecutor = executor({
      map_evidence: adapter(async ({ callProvider }) => {
        const first = callProvider(async (signal, budget) => {
          firstDispatches += 1;
          firstSignal = signal;
          firstBudget = budget;
          firstStarted();
          return new Promise<never>(() => undefined);
        }, 'model');
        void first.catch(() => undefined);
        await firstCallStarted;
        await callProvider(async () => {
          secondDispatches += 1;
          return { usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 } };
        }, 'model');
        await first;
        return {};
      }),
    });
    const service = manager(repositories, runExecutor, undefined, { leaseTtlMilliseconds: 3_000, renewalIntervalMilliseconds: 100 });
    const started = successful(await service.start(startInput(caseRevision.caseId, plan.planId)));
    const failed = await waitFor(() => repositories.runs.get(started.runId), (run) => run?.status === 'failed');
    expect(failed?.stoppingReason).toBe('limit_reached');
    expect(firstBudget).toEqual({ maxInputTokens: limits.maxModelInputTokens, maxOutputTokens: limits.maxModelOutputTokens });
    expect(firstDispatches).toBe(1);
    expect(secondDispatches).toBe(0);
    expect(firstSignal?.aborted).toBe(true);
    await service.shutdown();
  });

  it('keeps a lease after terminal persistence fails and recovers the expired run', async () => {
    const db = database();
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const repositories = makeRepositories(db, clock);
    const { caseRevision, plan } = seedRunnable(repositories);
    const updateRuntime = repositories.runs.updateRuntime.bind(repositories.runs);
    repositories.runs.updateRuntime = (runId, update, lease) => {
      if (update.status && ['completed', 'failed', 'cancelled', 'interrupted'].includes(update.status)) {
        throw new Error('Synthetic terminal persistence failure');
      }
      return updateRuntime(runId, update, lease);
    };
    const service = manager(repositories, executor(), clock, { leaseTtlMilliseconds: 300, renewalIntervalMilliseconds: 50 });
    const started = successful(await service.start(startInput(caseRevision.caseId, plan.planId)));
    await waitFor(
      () => repositories.runs.get(started.runId),
      (run) => run?.status === 'running' && run.steps.every((step) => step.status === 'succeeded'),
    );
    await service.shutdown();
    const heldLease = db.prepare('SELECT owner_instance_id FROM research_workspace_leases WHERE workspace_key = ?')
      .get('synthetic-workspace') as { owner_instance_id: string | null };
    expect(heldLease.owner_instance_id).not.toBeNull();
    expect(repositories.runs.get(started.runId)?.status).toBe('running');

    now += 1_000;
    expect(repositories.leases.recoverExpired()).toBe(started.runId);
    expect(repositories.runs.get(started.runId)).toMatchObject({ status: 'interrupted', stoppingReason: 'lease_lost' });
    const recoveredLease = db.prepare('SELECT owner_instance_id FROM research_workspace_leases WHERE workspace_key = ?')
      .get('synthetic-workspace') as { owner_instance_id: string | null };
    expect(recoveredLease.owner_instance_id).toBeNull();
  });

  it('marks token and cost totals unknown when shutdown interrupts a later paid call', async () => {
    const db = database();
    const repositories = makeRepositories(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { caseRevision, plan } = seedRunnable(repositories);
    let pendingCallStarted!: () => void;
    const pending = new Promise<void>((resolve) => { pendingCallStarted = resolve; });
    const runExecutor = executor({
      map_evidence: adapter(async ({ callProvider }) => {
        await callProvider(async () => ({ usage: { inputTokens: 12, outputTokens: 7, costMicros: 30 } }), 'model');
        await callProvider(async () => {
          pendingCallStarted();
          return await new Promise<never>(() => undefined);
        }, 'model');
        return {};
      }),
    });
    const service = manager(repositories, runExecutor, undefined, { leaseTtlMilliseconds: 3_000, renewalIntervalMilliseconds: 100 });
    const started = successful(await service.start(startInput(caseRevision.caseId, plan.planId)));
    await pending;
    expect(repositories.runs.get(started.runId)?.usage).toMatchObject({ modelInputTokens: 12, modelOutputTokens: 7, providerCostMicros: 30 });
    await service.shutdown();
    expect(repositories.runs.get(started.runId)).toMatchObject({
      status: 'interrupted',
      usage: { modelInputTokens: null, modelOutputTokens: null, providerCostMicros: null },
    });
  });

  it('does not wait for an abort-ignoring adapter on shutdown and marks the run interrupted', async () => {
    const db = database();
    const repositories = makeRepositories(db, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    const { caseRevision, plan } = seedRunnable(repositories);
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    const runExecutor: ResearchRunStepExecutor = {
      executeStep: async () => {
        entered();
        return await new Promise<never>(() => undefined);
      },
    };
    const service = manager(repositories, runExecutor, undefined, { leaseTtlMilliseconds: 3_000, renewalIntervalMilliseconds: 100 });
    const started = successful(await service.start(startInput(caseRevision.caseId, plan.planId)));
    await inFlight;
    await Promise.race([
      service.shutdown(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('shutdown waited on ignored adapter abort')), 500)),
    ]);
    expect(repositories.runs.get(started.runId)).toMatchObject({ status: 'interrupted', stoppingReason: 'service_shutdown' });
  });

  it('enforces a durable deadline and records unknown provider usage as null', async () => {
    const db = database();
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = { now: () => new Date(now) };
    const repositories = makeRepositories(db, clock);
    const oneSecond = { ...limits, maxWallTimeSeconds: 1 };
    const { caseRevision, plan } = seedRunnable(repositories, oneSecond);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const runExecutor = executor({
      map_evidence: adapter(async ({ callProvider }) => {
        entered();
        await callProvider(async (_signal, tokenBudget) => {
          expect(tokenBudget).toEqual({ maxInputTokens: 1000, maxOutputTokens: 500 });
          await gate;
          return { usage: { inputTokens: null, outputTokens: null, costMicros: null } };
        }, 'model');
        return {};
      }),
    });
    const service = manager(repositories, runExecutor, clock, { leaseTtlMilliseconds: 30_000, renewalIntervalMilliseconds: 1000 });
    const started = successful(await service.start(startInput(caseRevision.caseId, plan.planId)));
    await waiting;
    now += 2_000;
    release();
    const final = await waitFor(() => repositories.runs.get(started.runId), (run) => run?.status === 'failed');
    expect(final).toMatchObject({ stoppingReason: 'deadline_reached', usage: { modelInputTokens: null, modelOutputTokens: null, providerCostMicros: null } });
    expect(final?.coverageGaps).toContainEqual(expect.objectContaining({ reason: 'time_limit' }));
    await service.shutdown();
  });

  it('serializes starts across processes and recovers a crashed owner without losing partial evidence', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-run-coordination-'));
    scratchDirectories.push(directory);
    const filename = path.join(directory, 'research.sqlite');
    const db = database(filename);
    const repositories = makeRepositories(db, { now: () => new Date() });
    const { caseRevision, plan } = seedRunnable(repositories);

    const owner = spawnCoordinationWorker('owner', filename, caseRevision.caseId, plan.planId);
    const ownerClosed = once(owner.child, 'close');
    const ownerStart = await owner.nextLine('START_RESULT:');
    const ownerResponse = JSON.parse(ownerStart.slice('START_RESULT:'.length)) as ResearchResponse<StartRunResult>;
    const started = successful(ownerResponse);
    await owner.nextLine('FETCH_STEP_STARTED');
    expect(repositories.evidence.list(started.runId)).toHaveLength(1);

    const contender = spawnCoordinationWorker('contender', filename, caseRevision.caseId, plan.planId);
    const contenderClosed = once(contender.child, 'close');
    const contenderStart = await contender.nextLine('START_RESULT:');
    const contenderResponse = JSON.parse(contenderStart.slice('START_RESULT:'.length)) as ResearchResponse<StartRunResult>;
    expect(contenderResponse).toMatchObject({ error: { code: 'BUSY', details: { kind: 'busy', activeRunId: started.runId } } });
    await contenderClosed;
    expect(countRows(db, 'research_runs')).toBe(1);
    expect(countRows(db, 'research_idempotency_receipts')).toBe(1);

    owner.child.kill('SIGKILL');
    await ownerClosed;
    await new Promise((resolve) => setTimeout(resolve, 850));

    const restartedManager = manager(repositories, executor(), { now: () => new Date() }, { leaseTtlMilliseconds: 2_000, renewalIntervalMilliseconds: 200 });
    expect(repositories.runs.get(started.runId)).toMatchObject({ status: 'interrupted', stoppingReason: 'lease_lost' });
    expect(repositories.evidence.list(started.runId)).toHaveLength(1);
    await restartedManager.shutdown();
  });
});
