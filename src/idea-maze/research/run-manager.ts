import { randomUUID } from 'node:crypto';

import {
  RESEARCH_SCHEMA_VERSION,
  type CancelRunInput,
  type CancelRunResult,
  type ResearchFailure,
  type ResearchLimits,
  type ResearchAssessment,
  type ResearchResponse,
  type ResearchRun,
  type ResearchStepName,
  type WorkspaceRunLease,
  type RunStatusResult,
  type StartRunInput,
  type StartRunResult,
  success,
} from './contracts.ts';
import type { ResearchClock, TokenBudget } from './ports.ts';
import {
  ActiveWorkspaceLeaseError,
  CaseRevisionConflictError,
  IdempotencyConflictError,
  PlanCaseRevisionConflictError,
  RepositoryNotFoundError,
  StaleWorkspaceLeaseError,
  type ResearchRepositories,
} from './repositories.ts';
import {
  ContractValidationError,
  validateToolInput,
  validationFailure,
} from './validation.ts';
import {
  ResearchRunControlError,
  type ResearchRunControlReason,
  type ResearchRunStepExecutor,
  type ResearchStepAdapterContext,
  type ResearchStepOutput,
} from './run-step-executor.ts';

const STEP_ORDER: readonly ResearchStepName[] = ['search', 'fetch_originals', 'map_evidence', 'assess'];
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_RENEW_INTERVAL_MS = 5_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 1_000;
const CONTROL_DRAIN_GRACE_MS = 50;

export interface ResearchRunManagerOptions {
  repositories: ResearchRepositories;
  executor: ResearchRunStepExecutor;
  clock: ResearchClock;
  serviceSignal: AbortSignal;
  limits: ResearchLimits;
  ownerInstanceId?: string;
  leaseTtlMilliseconds?: number;
  renewalIntervalMilliseconds?: number;
  maintenanceIntervalMilliseconds?: number;
}

export interface ResearchRunManager {
  start(input: StartRunInput): Promise<ResearchResponse<StartRunResult>>;
  status(input: { runId: string }): Promise<ResearchResponse<RunStatusResult>>;
  cancel(input: CancelRunInput): Promise<ResearchResponse<CancelRunResult>>;
  /** Stops local work, persists interruption where this process still owns a lease, and waits for it. */
  shutdown(): Promise<void>;
}

interface RunTaskState {
  runId: string;
  controller: AbortController;
  lease: WorkspaceRunLease;
  done: Promise<void>;
  remainingModelInputTokens: number;
  remainingModelOutputTokens: number;
  inputTokensKnown: boolean;
  outputTokensKnown: boolean;
  costKnown: boolean;
  hasCostObservation: boolean;
  pendingControlReason: ResearchRunControlReason | null;
  providerCallsInFlight: number;
  unaccountedModelCalls: number;
  unaccountedCostCalls: number;
  controlGraceTimer: ReturnType<typeof setTimeout> | null;
}

function clockIso(clock: ResearchClock): string {
  const value = clock.now();
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value as unknown as string);
  if (!Number.isFinite(milliseconds)) throw new TypeError('The research clock returned an invalid date');
  return new Date(milliseconds).toISOString();
}

function clockMilliseconds(clock: ResearchClock): number {
  return Date.parse(clockIso(clock));
}

function failure(
  code: ResearchFailure['error']['code'],
  message: string,
  details: ResearchFailure['error']['details'],
  retryable = false,
): ResearchFailure {
  return { schemaVersion: RESEARCH_SCHEMA_VERSION, error: { code, message, retryable, details } };
}

function internalFailure(message = 'The research request could not be completed.'): ResearchFailure {
  return failure('INTERNAL_ERROR', message, { kind: 'internal' });
}

function notFound(resource: 'case' | 'plan' | 'run', id: string): ResearchFailure {
  return failure('NOT_FOUND', `The ${resource} was not found in this workspace.`, { kind: 'not_found', resource, id });
}

function limitFailure(name: keyof ResearchLimits, limit: number, requested: number): ResearchFailure {
  return failure('LIMIT_EXCEEDED', 'The research plan exceeds a configured workspace limit.', {
    kind: 'limit_exceeded', limitName: name, limit, requested,
  });
}

function mapError(error: unknown, request?: StartRunInput): ResearchFailure {
  if (error instanceof ContractValidationError) return validationFailure(error);
  if (error instanceof IdempotencyConflictError) {
    return failure('IDEMPOTENCY_CONFLICT', 'The idempotency key was already used with different input.', {
      kind: 'idempotency_conflict', operation: error.operation,
    });
  }
  if (error instanceof ActiveWorkspaceLeaseError) {
    return failure('BUSY', 'Another research run is active in this workspace.', {
      kind: 'busy', activeRunId: error.runId,
    }, true);
  }
  if (error instanceof RepositoryNotFoundError) {
    if (error.resource === 'case' || error.resource === 'plan' || error.resource === 'run') {
      return notFound(error.resource, error.id);
    }
  }
  if (error instanceof CaseRevisionConflictError) {
    return failure('REVISION_CONFLICT', 'The case revision is stale.', {
      kind: 'revision_conflict', caseId: error.caseId,
      expectedRevision: error.expectedRevision, currentRevision: error.currentRevision,
    });
  }
  if (error instanceof PlanCaseRevisionConflictError && request) {
    return failure('REVISION_CONFLICT', 'The plan is bound to a different case revision.', {
      kind: 'plan_revision_conflict', caseId: error.caseId, planId: request.planId,
      expectedCaseRevision: request.expectedCaseRevision, planCaseRevision: error.currentRevision,
      currentCaseRevision: request.expectedCaseRevision,
    });
  }
  return internalFailure();
}

function stoppedFailure(): ResearchFailure {
  return internalFailure('The research service is not active.');
}

function isTerminal(status: ResearchRun['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
}

function addCoverageGaps(
  current: ResearchRun['coverageGaps'],
  additions: ResearchRun['coverageGaps'],
): ResearchRun['coverageGaps'] {
  const result = [...current];
  for (const gap of additions) {
    if (!result.some((existing) => existing.reason === gap.reason && existing.detail === gap.detail &&
      existing.queryId === gap.queryId && existing.hypothesisId === gap.hypothesisId)) result.push(gap);
  }
  return result;
}

/**
 * Owns queued runs independently from request/transport lifetimes. The only
 * background work is explicit run execution plus lease/cancellation upkeep.
 */
export function createResearchRunManager(options: ResearchRunManagerOptions): ResearchRunManager {
  const { repositories, executor, clock, serviceSignal, limits } = options;
  if (!repositories || typeof repositories.runs?.get !== 'function' || typeof executor?.executeStep !== 'function') {
    throw new TypeError('Research repositories and a run step executor are required');
  }
  if (!clock || typeof clock.now !== 'function') throw new TypeError('A research clock is required');
  if (!serviceSignal || typeof serviceSignal.addEventListener !== 'function') throw new TypeError('A service signal is required');
  if (!limits || typeof limits !== 'object') throw new TypeError('Workspace research limits are required');
  for (const key of ['maxQueries', 'maxFetchedPages', 'maxFollowUpRounds', 'maxWallTimeSeconds', 'maxModelInputTokens', 'maxModelOutputTokens'] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) throw new RangeError(`Workspace limit ${key} must be a non-negative integer`);
  }

  const ownerInstanceId = options.ownerInstanceId ?? `research-owner-${randomUUID()}`;
  const leaseTtlMilliseconds = options.leaseTtlMilliseconds ?? DEFAULT_LEASE_TTL_MS;
  const renewalIntervalMilliseconds = options.renewalIntervalMilliseconds ?? Math.min(DEFAULT_RENEW_INTERVAL_MS, Math.floor(leaseTtlMilliseconds / 3));
  const maintenanceIntervalMilliseconds = options.maintenanceIntervalMilliseconds ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
  if (!Number.isSafeInteger(leaseTtlMilliseconds) || leaseTtlMilliseconds < 300) throw new RangeError('leaseTtlMilliseconds must be at least 300');
  if (!Number.isSafeInteger(renewalIntervalMilliseconds) || renewalIntervalMilliseconds < 25 || renewalIntervalMilliseconds >= leaseTtlMilliseconds) {
    throw new RangeError('renewalIntervalMilliseconds must be positive and shorter than the lease TTL');
  }
  if (!Number.isSafeInteger(maintenanceIntervalMilliseconds) || maintenanceIntervalMilliseconds < 25) {
    throw new RangeError('maintenanceIntervalMilliseconds must be at least 25');
  }

  let stopped = serviceSignal.aborted;
  let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  const tasks = new Map<string, RunTaskState>();

  function abortTaskNow(task: RunTaskState, reason: ResearchRunControlReason): void {
    if (!task.controller.signal.aborted) task.controller.abort(new ResearchRunControlError(reason));
  }

  function requestTaskStop(task: RunTaskState, reason: ResearchRunControlReason): void {
    if (task.controller.signal.aborted) return;
    task.pendingControlReason ??= reason;
    if (task.providerCallsInFlight > 0 || reason === 'lease_lost') {
      abortTaskNow(task, reason);
      return;
    }
    if (!task.controlGraceTimer) {
      task.controlGraceTimer = setTimeout(() => {
        task.controlGraceTimer = null;
        abortTaskNow(task, task.pendingControlReason ?? reason);
      }, CONTROL_DRAIN_GRACE_MS);
      task.controlGraceTimer.unref?.();
    }
  }

  function abortRecoveredRun(runId: string | null): void {
    if (!runId) return;
    const local = tasks.get(runId);
    if (local) abortTaskNow(local, 'lease_lost');
  }

  function runMaintenance(): void {
    try {
      abortRecoveredRun(repositories.leases.recoverExpired());
    } catch {
      // A later bounded maintenance tick retries transient SQLite contention.
    }
  }

  function onServiceAbort(): void {
    stopped = true;
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    for (const task of tasks.values()) requestTaskStop(task, 'service_shutdown');
  }

  if (!stopped) {
    serviceSignal.addEventListener('abort', onServiceAbort, { once: true });
    // Startup recovery is service-owned maintenance. Read methods stay pure.
    runMaintenance();
    maintenanceTimer = setInterval(runMaintenance, maintenanceIntervalMilliseconds);
    maintenanceTimer.unref?.();
  }

  function assertServiceActive(): boolean {
    return !stopped && !serviceSignal.aborted;
  }

  function scheduleRun(runId: string, lease: WorkspaceRunLease, planLimits: ResearchLimits): void {
    const state: RunTaskState = {
      runId,
      controller: new AbortController(),
      lease,
      done: Promise.resolve(),
      remainingModelInputTokens: 0,
      remainingModelOutputTokens: 0,
      inputTokensKnown: true,
      outputTokensKnown: true,
      costKnown: true,
      hasCostObservation: false,
      pendingControlReason: null,
      providerCallsInFlight: 0,
      unaccountedModelCalls: 0,
      unaccountedCostCalls: 0,
      controlGraceTimer: null,
    };
    state.remainingModelInputTokens = planLimits.maxModelInputTokens;
    state.remainingModelOutputTokens = planLimits.maxModelOutputTokens;
    tasks.set(runId, state);
    state.done = new Promise<void>((resolve) => {
      setImmediate(() => {
        void executeRun(state).catch(() => undefined).finally(resolve);
      });
    }).finally(() => {
      tasks.delete(runId);
    });
  }

  async function start(input: StartRunInput): Promise<ResearchResponse<StartRunResult>> {
    if (!assertServiceActive()) return stoppedFailure();
    let request: StartRunInput;
    try {
      request = validateToolInput('research_start', input);
    } catch (error) {
      return error instanceof ContractValidationError ? validationFailure(error) : internalFailure();
    }

    let createdLease: WorkspaceRunLease | null = null;
    let recoveredRunId: string | null = null;
    let createdPlanLimits: ResearchLimits | null = null;
    try {
      const outcome = repositories.idempotency.execute('research_start', request.idempotencyKey, request, () => {
        const caseRevision = repositories.cases.get(request.caseId);
        if (!caseRevision) throw new RepositoryNotFoundError('case', request.caseId);
        if (caseRevision.revision !== request.expectedCaseRevision) {
          throw new CaseRevisionConflictError(request.caseId, request.expectedCaseRevision, caseRevision.revision);
        }
        const plan = repositories.plans.get(request.planId);
        if (!plan) throw new RepositoryNotFoundError('plan', request.planId);
        if (plan.caseId !== request.caseId || plan.caseRevision !== request.expectedCaseRevision) {
          throw new PlanCaseRevisionConflictError(request.caseId, request.expectedCaseRevision, plan.caseRevision);
        }
        const exceeded = (Object.keys(limits) as Array<keyof ResearchLimits>)
          .find((name) => plan.limits[name] > limits[name]);
        if (exceeded) throw new PlanLimitExceededError(exceeded, limits[exceeded], plan.limits[exceeded]);

        const run = repositories.runs.create({ caseId: request.caseId, caseRevision: request.expectedCaseRevision, planId: request.planId });
        const acquired = repositories.leases.acquireWithRecovery({
          runId: run.runId,
          ownerInstanceId,
          ttlMilliseconds: leaseTtlMilliseconds,
        });
        createdLease = acquired.lease;
        recoveredRunId = acquired.recoveredRunId;
        createdPlanLimits = plan.limits;
        return success<StartRunResult>({
          runId: run.runId,
          status: 'queued',
          caseId: run.caseId,
          caseRevision: run.caseRevision,
          planId: run.planId,
          acceptedAt: clockIso(clock),
        });
      });

      if (!outcome.replayed && createdLease) {
        abortRecoveredRun(recoveredRunId);
        scheduleRun(outcome.value.data.runId, createdLease, createdPlanLimits!);
      }
      return outcome.value;
    } catch (error) {
      if (error instanceof PlanLimitExceededError) return limitFailure(error.limitName, error.limit, error.requested);
      return mapError(error, request);
    }
  }

  async function status(input: { runId: string }): Promise<ResearchResponse<RunStatusResult>> {
    if (!assertServiceActive()) return stoppedFailure();
    let request: { runId: string };
    try {
      request = validateToolInput('research_status', input);
    } catch (error) {
      return error instanceof ContractValidationError ? validationFailure(error) : internalFailure();
    }
    try {
      const run = repositories.runs.get(request.runId);
      if (!run) return notFound('run', request.runId);
      return success(toRunStatus(run));
    } catch {
      return internalFailure();
    }
  }

  async function cancel(input: CancelRunInput): Promise<ResearchResponse<CancelRunResult>> {
    if (!assertServiceActive()) return stoppedFailure();
    let request: CancelRunInput;
    try {
      request = validateToolInput('research_cancel', input);
    } catch (error) {
      return error instanceof ContractValidationError ? validationFailure(error) : internalFailure();
    }
    try {
      const outcome = repositories.idempotency.execute('research_cancel', request.idempotencyKey, request, () => {
        const run = repositories.runs.get(request.runId);
        if (!run) throw new RepositoryNotFoundError('run', request.runId);
        const updated = repositories.runs.requestCancellation(request.runId, clockIso(clock));
        return success<CancelRunResult>({
          runId: request.runId,
          status: updated.status,
          cancellationRequested: updated.status === 'cancellation_requested',
          cancelRequestedAt: updated.cancelRequestedAt,
        });
      });
      if (outcome.value.data.cancellationRequested) {
        const local = tasks.get(request.runId);
        if (local) requestTaskStop(local, 'cancelled');
      }
      return outcome.value;
    } catch (error) {
      return mapError(error);
    }
  }

  function toRunStatus(run: ResearchRun): RunStatusResult {
    return {
      runId: run.runId,
      caseId: run.caseId,
      caseRevision: run.caseRevision,
      planId: run.planId,
      status: run.status,
      steps: run.steps,
      usage: run.usage,
      coverageGaps: run.coverageGaps,
      stoppingReason: run.stoppingReason,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      cancelRequestedAt: run.cancelRequestedAt,
    };
  }

  function assertLease(task: RunTaskState): void {
    try {
      repositories.leases.assertCurrent(task.lease);
    } catch {
      abortTaskNow(task, 'lease_lost');
      throw new ResearchRunControlError('lease_lost');
    }
  }

  function assertCanDispatch(task: RunTaskState, deadlineMs: number): void {
    if (serviceSignal.aborted || stopped) {
      requestTaskStop(task, 'service_shutdown');
      throw new ResearchRunControlError('service_shutdown');
    }
    if (task.controller.signal.aborted) {
      throw task.controller.signal.reason instanceof ResearchRunControlError
        ? task.controller.signal.reason
        : new ResearchRunControlError('service_shutdown');
    }
    if (task.pendingControlReason) {
      abortTaskNow(task, task.pendingControlReason);
      throw new ResearchRunControlError(task.pendingControlReason);
    }
    assertLease(task);
    const run = repositories.runs.get(task.runId);
    if (!run) throw new ResearchRunControlError('lease_lost');
    if (run.status === 'cancellation_requested') {
      requestTaskStop(task, 'cancelled');
      throw new ResearchRunControlError('cancelled');
    }
    if (isTerminal(run.status)) {
      abortTaskNow(task, 'lease_lost');
      throw new ResearchRunControlError('lease_lost');
    }
    if (clockMilliseconds(clock) >= deadlineMs) {
      requestTaskStop(task, 'deadline_reached');
      throw new ResearchRunControlError('deadline_reached');
    }
  }

  function observeControlAfterReturn(task: RunTaskState, deadlineMs: number): void {
    if (serviceSignal.aborted || stopped) {
      requestTaskStop(task, 'service_shutdown');
      return;
    }
    if (task.controller.signal.aborted) return;
    const run = repositories.runs.get(task.runId);
    if (!run || isTerminal(run.status)) {
      abortTaskNow(task, 'lease_lost');
      return;
    }
    if (run.status === 'cancellation_requested') {
      requestTaskStop(task, 'cancelled');
      return;
    }
    if (clockMilliseconds(clock) >= deadlineMs) requestTaskStop(task, 'deadline_reached');
  }

  async function raceWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason ?? new ResearchRunControlError('service_shutdown');
    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new ResearchRunControlError('service_shutdown'));
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
        (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
      );
    });
  }

  function applyKnownMetric(
    state: RunTaskState,
    field: 'modelInputTokens' | 'modelOutputTokens' | 'providerCostMicros',
    value: number | null | undefined,
    addToUsage: (delta: number) => void,
  ): void {
    if (value === undefined) return;
    const knownKey = field === 'modelInputTokens' ? 'inputTokensKnown'
      : field === 'modelOutputTokens' ? 'outputTokensKnown' : 'costKnown';
    if (value === null || !Number.isSafeInteger(value) || value < 0) {
      state[knownKey] = false;
      return;
    }
    if (!state[knownKey]) return;
    addToUsage(value);
    if (field === 'providerCostMicros') state.hasCostObservation = true;
  }

  async function persistUsage(task: RunTaskState, run: ResearchRun, patch?: ResearchStepOutput['usage']): Promise<ResearchRun> {
    const usage = { ...run.usage };
    if (patch?.searchRequests !== undefined) {
      if (!Number.isSafeInteger(patch.searchRequests) || patch.searchRequests < 0) throw new TypeError('Search usage must be a non-negative integer');
      usage.searchRequests += patch.searchRequests;
      if (usage.searchRequests > run.snapshot.plan.limits.maxQueries) task.pendingControlReason ??= 'limit_reached';
    }
    if (patch?.fetchedPages !== undefined) {
      if (!Number.isSafeInteger(patch.fetchedPages) || patch.fetchedPages < 0) throw new TypeError('Fetch usage must be a non-negative integer');
      usage.fetchedPages += patch.fetchedPages;
      if (usage.fetchedPages > run.snapshot.plan.limits.maxFetchedPages) task.pendingControlReason ??= 'limit_reached';
    }
    const inputDelta = patch?.modelInputTokens;
    if (inputDelta !== undefined && inputDelta !== null &&
        (!Number.isSafeInteger(inputDelta) || inputDelta < 0 || inputDelta > task.remainingModelInputTokens)) {
      task.remainingModelInputTokens = 0;
      task.inputTokensKnown = false;
      task.pendingControlReason ??= 'limit_reached';
    } else if (inputDelta === null) {
      task.remainingModelInputTokens = 0;
    } else if (inputDelta !== undefined) {
      task.remainingModelInputTokens -= inputDelta;
    }
    const outputDelta = patch?.modelOutputTokens;
    if (outputDelta !== undefined && outputDelta !== null &&
        (!Number.isSafeInteger(outputDelta) || outputDelta < 0 || outputDelta > task.remainingModelOutputTokens)) {
      task.remainingModelOutputTokens = 0;
      task.outputTokensKnown = false;
      task.pendingControlReason ??= 'limit_reached';
    } else if (outputDelta === null) {
      task.remainingModelOutputTokens = 0;
    } else if (outputDelta !== undefined) {
      task.remainingModelOutputTokens -= outputDelta;
    }
    applyKnownMetric(task, 'modelInputTokens', task.inputTokensKnown ? inputDelta : null, (value) => {
      usage.modelInputTokens = (usage.modelInputTokens ?? 0) + value;
    });
    applyKnownMetric(task, 'modelOutputTokens', task.outputTokensKnown ? outputDelta : null, (value) => {
      usage.modelOutputTokens = (usage.modelOutputTokens ?? 0) + value;
    });
    applyKnownMetric(task, 'providerCostMicros', patch?.providerCostMicros, (value) => {
      usage.providerCostMicros = (usage.providerCostMicros ?? 0) + value;
    });
    if (!task.inputTokensKnown) usage.modelInputTokens = null;
    if (!task.outputTokensKnown) usage.modelOutputTokens = null;
    if (!task.costKnown || !task.hasCostObservation) usage.providerCostMicros = null;
    const current = repositories.runs.get(task.runId);
    if (!current) throw new RepositoryNotFoundError('run', task.runId);
    return repositories.runs.updateRuntime(task.runId, { usage }, task.lease);
  }

  function monitorTask(task: RunTaskState): void {
    if (task.controller.signal.aborted) return;
    if (serviceSignal.aborted || stopped) {
      requestTaskStop(task, 'service_shutdown');
      return;
    }
    try {
      const run = repositories.runs.get(task.runId);
      if (!run || isTerminal(run.status)) {
        abortTaskNow(task, 'lease_lost');
        return;
      }
      if (run.status === 'cancellation_requested') {
        requestTaskStop(task, 'cancelled');
        return;
      }
      task.lease = repositories.leases.renew(task.lease, leaseTtlMilliseconds);
    } catch (error) {
      if (error instanceof StaleWorkspaceLeaseError) abortTaskNow(task, 'lease_lost');
    }
  }

  async function persistStepOutput(task: RunTaskState, output: ResearchStepOutput): Promise<ResearchRun> {
    assertLease(task);
    for (const evidence of output.evidence ?? []) repositories.evidence.save(task.runId, evidence, task.lease);
    if (output.assessment) repositories.assessments.save(task.runId, output.assessment, task.lease);
    const current = repositories.runs.get(task.runId);
    if (!current) throw new RepositoryNotFoundError('run', task.runId);
    const usage = output.usage ? await persistUsage(task, current, output.usage) : current;
    const gaps = addCoverageGaps(usage.coverageGaps, [
      ...(output.coverageGaps ?? []),
      ...(output.assessment?.coverageGaps ?? []),
    ]);
    return repositories.runs.updateRuntime(task.runId, { coverageGaps: gaps }, task.lease);
  }

  async function executeRun(task: RunTaskState): Promise<void> {
    const originalServiceAborted = () => requestTaskStop(task, 'service_shutdown');
    serviceSignal.addEventListener('abort', originalServiceAborted, { once: true });
    let terminalPersisted = false;
    let budgetAssessmentPersisted = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let initial: ResearchRun | null = null;

    try {
      initial = repositories.runs.get(task.runId);
      if (!initial) {
        terminalPersisted = true;
        return;
      }
      const deadlineMs = Date.parse(initial.createdAt) + initial.snapshot.plan.limits.maxWallTimeSeconds * 1000;
      deadlineTimer = setTimeout(() => requestTaskStop(task, 'deadline_reached'), Math.max(0, deadlineMs - clockMilliseconds(clock)));
      deadlineTimer.unref?.();
      heartbeat = setInterval(() => monitorTask(task), renewalIntervalMilliseconds);
      heartbeat.unref?.();

      if (initial.status === 'cancellation_requested') requestTaskStop(task, 'cancelled');
      if (serviceSignal.aborted || stopped) requestTaskStop(task, 'service_shutdown');
      if (task.pendingControlReason) {
        const reason = task.pendingControlReason;
        abortTaskNow(task, reason);
        throw new ResearchRunControlError(reason);
      }
      if (task.controller.signal.aborted) throw task.controller.signal.reason;

      const startedAt = clockIso(clock);
      const starting = repositories.runs.updateRuntime(task.runId, { status: 'running', startedAt }, task.lease);
      if (starting.status === 'cancellation_requested') {
        abortTaskNow(task, 'cancelled');
        throw new ResearchRunControlError('cancelled');
      }

      for (const step of STEP_ORDER) {
        assertCanDispatch(task, deadlineMs);
        const before = repositories.runs.get(task.runId);
        if (!before) throw new ResearchRunControlError('lease_lost');
        const started = clockIso(clock);
        repositories.runs.saveStep(task.runId, {
          name: step,
          status: 'running',
          startedAt: started,
          finishedAt: null,
          failureCode: null,
          providerAvailability: null,
        }, task.lease);

        const callProvider: ResearchStepAdapterContext['callProvider'] = async <T>(call, capability): Promise<T> => {
          assertCanDispatch(task, deadlineMs);
          let tokenBudget: TokenBudget | null = null;
          const nowRun = repositories.runs.get(task.runId);
          if (!nowRun) throw new ResearchRunControlError('lease_lost');
          let usage = { ...nowRun.usage };
          if (capability === 'search') {
            if (usage.searchRequests >= before.snapshot.plan.limits.maxQueries) {
              requestTaskStop(task, 'limit_reached');
              throw new ResearchRunControlError('limit_reached');
            }
            usage.searchRequests += 1;
          } else if (capability === 'original_source_fetch') {
            if (usage.fetchedPages >= before.snapshot.plan.limits.maxFetchedPages) {
              requestTaskStop(task, 'limit_reached');
              throw new ResearchRunControlError('limit_reached');
            }
            usage.fetchedPages += 1;
          } else if (capability === 'model') {
            if (task.remainingModelInputTokens <= 0 || task.remainingModelOutputTokens <= 0) {
              requestTaskStop(task, 'limit_reached');
              throw new ResearchRunControlError('limit_reached');
            }
            tokenBudget = {
              maxInputTokens: task.remainingModelInputTokens,
              maxOutputTokens: task.remainingModelOutputTokens,
            };
            // Reserve before dispatch so parallel calls cannot each spend the
            // same remaining allowance. A valid response refunds the unused part.
            task.remainingModelInputTokens = 0;
            task.remainingModelOutputTokens = 0;
          }
          if (capability === 'search' || capability === 'original_source_fetch') {
            repositories.runs.updateRuntime(task.runId, { usage }, task.lease);
          }

          let value: T;
          const tracksExternalCall = capability !== undefined;
          if (tracksExternalCall) task.providerCallsInFlight += 1;
          try {
            const raw = Promise.resolve().then(() => {
              // Recheck inside the dispatch microtask, after durable counters
              // and reservations have been written.
              assertCanDispatch(task, deadlineMs);
              if (capability === 'model') {
                task.unaccountedModelCalls += 1;
                task.unaccountedCostCalls += 1;
              } else if (capability === 'search' || capability === 'original_source_fetch') {
                task.unaccountedCostCalls += 1;
              }
              return call(task.controller.signal, tokenBudget);
            }) as Promise<T>;
            value = await raceWithSignal(raw, task.controller.signal);
          } catch (error) {
            if (tracksExternalCall) task.providerCallsInFlight = Math.max(0, task.providerCallsInFlight - 1);
            let uncertaintyPersisted = false;
            if (capability === 'model') {
              task.inputTokensKnown = false;
              task.outputTokensKnown = false;
              task.costKnown = false;
              try {
                const afterFailure = repositories.runs.get(task.runId);
                if (afterFailure) repositories.runs.updateRuntime(task.runId, {
                  usage: { ...afterFailure.usage, modelInputTokens: null, modelOutputTokens: null, providerCostMicros: null },
                }, task.lease);
                uncertaintyPersisted = Boolean(afterFailure);
              } catch {
                // If ownership was lost, the stale owner cannot persist usage.
              }
            } else if (capability === 'search' || capability === 'original_source_fetch') {
              task.costKnown = false;
              try {
                const afterFailure = repositories.runs.get(task.runId);
                if (afterFailure) repositories.runs.updateRuntime(task.runId, {
                  usage: { ...afterFailure.usage, providerCostMicros: null },
                }, task.lease);
                uncertaintyPersisted = Boolean(afterFailure);
              } catch {
                // If ownership was lost, the stale owner cannot persist usage.
              }
            }
            if (uncertaintyPersisted) {
              if (capability === 'model') task.unaccountedModelCalls = Math.max(0, task.unaccountedModelCalls - 1);
              if (capability === 'model' || capability === 'search' || capability === 'original_source_fetch') {
                task.unaccountedCostCalls = Math.max(0, task.unaccountedCostCalls - 1);
              }
            }
            throw error;
          }
          if (tracksExternalCall) task.providerCallsInFlight = Math.max(0, task.providerCallsInFlight - 1);
          // Recheck ownership after every adapter return. Cancellation/deadline
          // aborts the next call while letting the current result be persisted.
          assertLease(task);
          observeControlAfterReturn(task, deadlineMs);
          const result = value && typeof value === 'object' ? value as Record<string, unknown> : {};
          const reportedUsage = result.usage && typeof result.usage === 'object'
            ? result.usage as Record<string, unknown>
            : result;
          const latest = repositories.runs.get(task.runId);
          if (!latest) throw new ResearchRunControlError('lease_lost');
          usage = { ...latest.usage };
          const validTokenDelta = (field: 'inputTokens' | 'outputTokens', reserved: number): number | null => {
            const currentValue = reportedUsage[field];
            return typeof currentValue === 'number' && Number.isSafeInteger(currentValue) && currentValue >= 0 && currentValue <= reserved
              ? currentValue
              : null;
          };
          if (capability === 'model') {
            const inputTokens = validTokenDelta('inputTokens', tokenBudget!.maxInputTokens);
            const outputTokens = validTokenDelta('outputTokens', tokenBudget!.maxOutputTokens);
            applyKnownMetric(task, 'modelInputTokens', inputTokens, (delta) => {
              usage.modelInputTokens = (usage.modelInputTokens ?? 0) + delta;
              task.remainingModelInputTokens = tokenBudget!.maxInputTokens - delta;
            });
            applyKnownMetric(task, 'modelOutputTokens', outputTokens, (delta) => {
              usage.modelOutputTokens = (usage.modelOutputTokens ?? 0) + delta;
              task.remainingModelOutputTokens = tokenBudget!.maxOutputTokens - delta;
            });
            if (inputTokens === null) {
              task.inputTokensKnown = false;
              task.remainingModelInputTokens = 0;
            }
            if (outputTokens === null) {
              task.outputTokensKnown = false;
              task.remainingModelOutputTokens = 0;
            }
            const cost = typeof reportedUsage.costMicros === 'number' ? reportedUsage.costMicros
              : null;
            applyKnownMetric(task, 'providerCostMicros', cost, (delta) => {
              usage.providerCostMicros = (usage.providerCostMicros ?? 0) + delta;
            });
          } else if (capability === 'search' || capability === 'original_source_fetch') {
            const cost = typeof result.costMicros === 'number' ? result.costMicros
              : null;
            applyKnownMetric(task, 'providerCostMicros', cost, (delta) => {
              usage.providerCostMicros = (usage.providerCostMicros ?? 0) + delta;
            });
          }
          if (!task.inputTokensKnown) usage.modelInputTokens = null;
          if (!task.outputTokensKnown) usage.modelOutputTokens = null;
          if (!task.costKnown || !task.hasCostObservation) usage.providerCostMicros = null;
          if (capability === 'model' || capability === 'search' || capability === 'original_source_fetch') {
            repositories.runs.updateRuntime(task.runId, { usage }, task.lease);
            if (capability === 'model') task.unaccountedModelCalls = Math.max(0, task.unaccountedModelCalls - 1);
            task.unaccountedCostCalls = Math.max(0, task.unaccountedCostCalls - 1);
          }
          return value;
        };

        const context: ResearchStepAdapterContext = {
          run: before,
          step,
          signal: task.controller.signal,
          deadlineAt: new Date(deadlineMs).toISOString(),
          maxModelInputTokens: task.remainingModelInputTokens,
          maxModelOutputTokens: task.remainingModelOutputTokens,
          maxSearchRequests: Math.max(0, before.snapshot.plan.limits.maxQueries - before.usage.searchRequests),
          maxFetchedPages: Math.max(0, before.snapshot.plan.limits.maxFetchedPages - before.usage.fetchedPages),
          maxFollowUpRounds: before.snapshot.plan.limits.maxFollowUpRounds,
          clock,
          providerVersion: null,
          cacheKeyFor: () => null,
          assertCanDispatch: () => assertCanDispatch(task, deadlineMs),
          callProvider,
          withWrite: (effect) => {
            assertLease(task);
            return repositories.leases.withWrite(task.lease, () => effect(task.lease));
          },
        };

        let result;
        try {
          const stepWork = Promise.resolve().then(() => {
            assertCanDispatch(task, deadlineMs);
            return executor.executeStep(context);
          });
          result = await raceWithSignal(stepWork, task.controller.signal);
        } catch (error) {
          if (error instanceof ResearchRunControlError) throw error;
          if (task.controller.signal.aborted) throw task.controller.signal.reason;
          result = {
            status: 'failed' as const,
            providerAvailability: null,
            failureCode: 'INTERNAL_ERROR' as const,
            output: {
              coverageGaps: [{
                reason: step === 'search' ? 'search_failed' as const : 'fetch_failed' as const,
                detail: 'The research step failed before it produced a complete result.',
                queryId: null,
                hypothesisId: null,
              }],
            },
          };
        }

        const afterOutput = await persistStepOutput(task, result.output);
        repositories.runs.saveStep(task.runId, {
          name: step,
          status: result.status,
          startedAt: started,
          finishedAt: clockIso(clock),
          failureCode: result.failureCode,
          providerAvailability: result.providerAvailability,
        }, task.lease);

        const canFinishBoundedAssessment = step === 'assess' && result.status === 'succeeded' &&
          task.pendingControlReason === 'limit_reached' && afterOutput.assessment !== null &&
          afterOutput.coverageGaps.some((gap) => gap.reason === 'budget_exhausted') &&
          !task.controller.signal.aborted;
        if (canFinishBoundedAssessment) {
          budgetAssessmentPersisted = true;
          if (task.controlGraceTimer) clearTimeout(task.controlGraceTimer);
          task.controlGraceTimer = null;
        } else if (task.pendingControlReason) {
          const reason = task.pendingControlReason;
          abortTaskNow(task, reason);
          throw new ResearchRunControlError(reason);
        }
        if (task.controller.signal.aborted) throw task.controller.signal.reason;
        if (result.status === 'failed') {
          if (task.providerCallsInFlight > 0) abortTaskNow(task, 'step_failed');
          const finishedAt = clockIso(clock);
          const terminal = repositories.runs.updateRuntime(task.runId, {
            status: 'failed',
            stoppingReason: 'step_failed',
            finishedAt,
            usage: terminalUsage(task, afterOutput.usage, initial.createdAt, clockMilliseconds(clock)),
          }, task.lease);
          terminalPersisted = isTerminal(terminal.status);
          if (terminal.status === 'cancellation_requested') {
            abortTaskNow(task, 'cancelled');
            throw new ResearchRunControlError('cancelled');
          }
          return;
        }
      }

      let completed = repositories.runs.get(task.runId);
      if (!completed) throw new ResearchRunControlError('lease_lost');
      if (task.providerCallsInFlight > 0) abortTaskNow(task, 'step_failed');
      if (!budgetAssessmentPersisted || task.controller.signal.aborted || task.pendingControlReason !== 'limit_reached') {
        assertCanDispatch(task, deadlineMs);
      }
      const hasVerifiedEvidence = repositories.evidence.list(task.runId).some((item) => item.kind === 'verified_excerpt');
      const collectionUnavailable = !hasVerifiedEvidence && completed.coverageGaps.some((gap) => gap.reason === 'provider_unavailable');
      const hasTimeLimitGap = completed.coverageGaps.some((gap) => gap.reason === 'time_limit');
      const hasBudgetGap = completed.coverageGaps.some((gap) => gap.reason === 'budget_exhausted');
      if (!completed.assessment) {
        repositories.assessments.save(task.runId, insufficientEvidenceAssessment(completed), task.lease);
        completed = repositories.runs.get(task.runId);
        if (!completed) throw new ResearchRunControlError('lease_lost');
      }
      const terminal = repositories.runs.updateRuntime(task.runId, {
        status: 'completed',
        stoppingReason: hasTimeLimitGap ? 'deadline_reached'
          : hasBudgetGap ? 'limit_reached'
            : collectionUnavailable ? 'provider_unavailable' : 'all_steps_finished',
        finishedAt: clockIso(clock),
        usage: terminalUsage(task, completed.usage, initial.createdAt, clockMilliseconds(clock)),
      }, task.lease);
      terminalPersisted = isTerminal(terminal.status);
      if (terminal.status === 'cancellation_requested') {
        abortTaskNow(task, 'cancelled');
        throw new ResearchRunControlError('cancelled');
      }
    } catch (error) {
      const reason = error instanceof ResearchRunControlError
        ? error.reason
        : task.controller.signal.aborted && task.controller.signal.reason instanceof ResearchRunControlError
          ? task.controller.signal.reason.reason
          : null;
      if (reason === 'lease_lost' || error instanceof StaleWorkspaceLeaseError) return;
      if (!task.controller.signal.aborted) abortTaskNow(task, reason ?? 'step_failed');
      try {
        const current = repositories.runs.get(task.runId);
        if (!current) {
          terminalPersisted = true;
          return;
        }
        if (isTerminal(current.status)) {
          terminalPersisted = true;
          return;
        }
        assertLease(task);
        const finishedAt = clockIso(clock);
        const effectiveReason = current.status === 'cancellation_requested' ? 'cancelled' : reason;
        const stoppingReason = effectiveReason === 'cancelled' ? 'cancelled'
          : effectiveReason === 'service_shutdown' ? 'service_shutdown'
            : effectiveReason === 'deadline_reached' ? 'deadline_reached'
              : effectiveReason === 'limit_reached' || effectiveReason === 'step_failed' ? effectiveReason : 'step_failed';
        const status = effectiveReason === 'cancelled' ? 'cancelled'
          : effectiveReason === 'service_shutdown' ? 'interrupted'
            : effectiveReason === 'deadline_reached' || effectiveReason === 'limit_reached' ? 'failed'
              : 'failed';
        const activeStep = current.steps.find((step) => step.status === 'running');
        const gapReason = effectiveReason === 'cancelled' ? 'cancelled'
          : effectiveReason === 'service_shutdown' ? 'interrupted'
            : effectiveReason === 'deadline_reached' ? 'time_limit'
              : effectiveReason === 'limit_reached' ? 'budget_exhausted'
                : activeStep?.name === 'search' ? 'search_failed' : 'fetch_failed';
        const gapDetail = effectiveReason === 'cancelled' ? 'The run was cancelled by an explicit request.'
          : effectiveReason === 'service_shutdown' ? 'The research service shut down while this run was active.'
            : effectiveReason === 'deadline_reached' ? 'The configured run wall-time limit was reached.'
              : effectiveReason === 'limit_reached' ? 'A configured research usage limit was reached.'
                : 'An internal research step error stopped the run.';
        const gaps = addCoverageGaps(current.coverageGaps, [{
          reason: gapReason,
          detail: gapDetail,
          queryId: null,
          hypothesisId: null,
        }]);
        if (activeStep) {
          repositories.runs.saveStep(task.runId, {
            ...activeStep,
            status: effectiveReason === 'cancelled' || effectiveReason === 'service_shutdown' ? 'cancelled' : 'failed',
            finishedAt,
            failureCode: effectiveReason === 'deadline_reached' || effectiveReason === 'limit_reached'
              ? 'LIMIT_EXCEEDED'
              : effectiveReason === 'cancelled' || effectiveReason === 'service_shutdown' ? activeStep.failureCode : 'INTERNAL_ERROR',
          }, task.lease);
        }
        const terminal = repositories.runs.updateRuntime(task.runId, {
          status,
          stoppingReason,
          finishedAt,
          coverageGaps: gaps,
          usage: terminalUsage(task, current.usage, current.createdAt, clockMilliseconds(clock)),
        }, task.lease);
        terminalPersisted = isTerminal(terminal.status);
      } catch {
        // The lease may have expired while finalizing. Recovery will fence and
        // interrupt the run; a stale process never writes through a newer epoch.
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (heartbeat) clearInterval(heartbeat);
      if (task.controlGraceTimer) clearTimeout(task.controlGraceTimer);
      serviceSignal.removeEventListener('abort', originalServiceAborted);
      if (terminalPersisted) {
        try { repositories.leases.release(task.lease); } catch { /* Lease expiry recovery remains available. */ }
      }
    }
  }

  function withElapsed(usage: ResearchRun['usage'], createdAt: string, now: number): ResearchRun['usage'] {
    return { ...usage, elapsedMilliseconds: Math.max(0, now - Date.parse(createdAt)) };
  }

  function terminalUsage(
    task: RunTaskState,
    usage: ResearchRun['usage'],
    createdAt: string,
    now: number,
  ): ResearchRun['usage'] {
    const terminal = withElapsed(usage, createdAt, now);
    if (task.unaccountedModelCalls > 0 || !task.inputTokensKnown) terminal.modelInputTokens = null;
    if (task.unaccountedModelCalls > 0 || !task.outputTokensKnown) terminal.modelOutputTokens = null;
    if (task.unaccountedCostCalls > 0 || !task.costKnown || !task.hasCostObservation) terminal.providerCostMicros = null;
    return terminal;
  }

  function insufficientEvidenceAssessment(run: ResearchRun): ResearchAssessment {
    const claims = run.snapshot.caseRevision.hypothesisRevisions
      .filter((hypothesis) => hypothesis.state === 'active')
      .map((hypothesis) => ({
        hypothesisId: hypothesis.hypothesisId,
        outcome: 'insufficient_evidence' as const,
        rationale: 'The run did not complete a usable assessment for this hypothesis.',
        supportingEvidenceIds: [],
        challengingEvidenceIds: [],
        missingEvidence: ['A completed assessment step is unavailable for this run.'],
      }));
    return {
      outcome: 'insufficient_evidence',
      summary: 'The run did not complete a usable evidence assessment.',
      rationale: 'Search excerpts are discovery records until they are verified against original sources and assessed.',
      claims,
      coverageGaps: run.coverageGaps,
      nextExperiment: 'Restore any unavailable collection or assessment providers, then explicitly start another run.',
    };
  }

  async function shutdown(): Promise<void> {
    if (!stopped) {
      stopped = true;
    }
    serviceSignal.removeEventListener('abort', onServiceAbort);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    for (const task of tasks.values()) requestTaskStop(task, 'service_shutdown');
    await Promise.allSettled([...tasks.values()].map((task) => task.done));
  }

  return Object.freeze({ start, status, cancel, shutdown });
}

class PlanLimitExceededError extends Error {
  constructor(readonly limitName: keyof ResearchLimits, readonly limit: number, readonly requested: number) {
    super('Research plan exceeds a workspace limit');
    this.name = 'PlanLimitExceededError';
  }
}
