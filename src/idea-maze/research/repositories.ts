import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import type {
  CoverageGap,
  HypothesisOrigin,
  HypothesisRevision,
  HypothesisSuggestion,
  HypothesisState,
  ResearchAssessment,
  ResearchCaseRunSnapshot,
  ResearchCaseRevision,
  ResearchEvidence,
  ResearchIntake,
  ResearchPlanSnapshot,
  ResearchQuery,
  ResearchRun,
  ResearchRunStep,
  ResearchUsage,
  RunExecutionStatus,
  RunStoppingReason,
  RunStepStatus,
  VerifiedEvidenceLink,
  WorkspaceRunLease,
  WriteOperation,
} from './contracts.ts';
import { migrateResearchSchema } from './migrations.ts';
import { verifyResearchExcerpt } from './provenance.ts';

export type ResearchIdKind = 'case' | 'hypothesis' | 'suggestion' | 'plan' | 'run';
export type ResearchClock = () => Date | string;
export type ResearchIdFactory = (kind: ResearchIdKind) => string;

export interface ResearchRepositoryOptions {
  /** An already-open SQLite connection. The repository never owns its lifetime. */
  db: Database.Database;
  /** Stable owner-workspace key supplied by the application context. */
  workspaceKey: string;
  /** Injected for deterministic persistence and lease behavior. */
  clock: ResearchClock;
  /** Optional deterministic ID source, useful for tests and host integrations. */
  idFactory?: ResearchIdFactory;
}

export interface CaseCreateRecord {
  intake?: ResearchIntake;
  hypotheses?: Array<{
    claim: string;
    origin?: 'user_supplied';
  } | {
    claim: string;
    origin: 'model_suggested';
    sourceSuggestionId: string;
  }>;
}

export type CaseHypothesisMutation =
  | ({ operation: 'add'; clientRef: string } & ({ claim: string; origin?: 'user_supplied' } | { claim: string; origin: 'model_suggested'; sourceSuggestionId: string }))
  | { operation: 'revise'; hypothesisId: string; expectedRevision: number; claim: string }
  | { operation: 'retire'; hypothesisId: string; expectedRevision: number };

export interface CaseUpdateRecord {
  caseId: string;
  expectedRevision: number;
  intakePatch?: ResearchIntake;
  hypothesisMutations?: CaseHypothesisMutation[];
}

export interface PlanCreateRecord {
  caseId: string;
  caseRevision: number;
  queries: Array<Omit<ResearchQuery, 'queryId'> & { queryId?: string }>;
  limits: ResearchPlanSnapshot['limits'];
}

export interface RunRuntimeUpdate {
  status?: RunExecutionStatus;
  usage?: ResearchUsage;
  coverageGaps?: CoverageGap[];
  stoppingReason?: RunStoppingReason | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancelRequestedAt?: string | null;
}

export interface SourceVersionInput {
  runId: string;
  sourceItemId: number;
  sourceText: string;
  sourceTextHash: string;
  canonicalUrl: string;
  retrievedAt: string;
}

export interface SourceVersionRecord {
  workspaceKey: string;
  sourceItemId: number;
  sourceTextHash: string;
  canonicalUrl: string;
  sourceText: string;
  retrievedAt: string;
}

export interface LeaseRequest {
  runId: string;
  ownerInstanceId: string;
  ttlMilliseconds: number;
}

export interface ExternalOperationClaim {
  ownerId: string;
  fencingToken: number;
}

export interface ExternalOperationUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  costMicros: number | null;
}

export type ExternalOperationObservation<T> =
  | { kind: 'absent' }
  | { kind: 'claimed'; claim: ExternalOperationClaim; deadlineAt: string }
  | { kind: 'pending'; ownerId: string; fencingToken: number; deadlineAt: string }
  | { kind: 'replay'; value: T }
  | { kind: 'unknown' };

export class ExternalOperationPendingError extends Error {
  constructor(readonly operation: WriteOperation) {
    super('An idempotent external operation is still pending');
    this.name = 'ExternalOperationPendingError';
  }
}

export class ExternalOperationOutcomeUnknownError extends Error {
  constructor(readonly operation: WriteOperation) {
    super('An idempotent external operation has an unknown outcome');
    this.name = 'ExternalOperationOutcomeUnknownError';
  }
}

export class RepositoryNotFoundError extends Error {
  readonly code = 'NOT_FOUND';

  constructor(readonly resource: string, readonly id: string) {
    super(`${resource} was not found`);
    this.name = 'RepositoryNotFoundError';
  }
}

export class CaseRevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';

  constructor(readonly caseId: string, readonly expectedRevision: number, readonly currentRevision: number) {
    super('The case revision is stale');
    this.name = 'CaseRevisionConflictError';
  }
}

export class HypothesisRevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';

  constructor(readonly hypothesisId: string, readonly expectedRevision: number, readonly currentRevision: number) {
    super('The hypothesis revision is stale');
    this.name = 'HypothesisRevisionConflictError';
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly operation: WriteOperation) {
    super('The idempotency key was already used with different input');
    this.name = 'IdempotencyConflictError';
  }
}

export class ActiveWorkspaceLeaseError extends Error {
  readonly code = 'BUSY';

  constructor(readonly runId: string) {
    super('The workspace already has an active research run');
    this.name = 'ActiveWorkspaceLeaseError';
  }
}

export class StaleWorkspaceLeaseError extends Error {
  readonly code = 'LEASE_LOST';

  constructor() {
    super('The workspace lease is no longer current and unexpired');
    this.name = 'StaleWorkspaceLeaseError';
  }
}

export class ImmutableRecordConflictError extends Error {
  constructor(readonly resource: string, readonly id: string) {
    super(`An immutable ${resource} record already exists with different content`);
    this.name = 'ImmutableRecordConflictError';
  }
}

export class PlanCaseRevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';

  constructor(readonly caseId: string, readonly expectedRevision: number, readonly currentRevision: number) {
    super('The plan must reference the current case revision');
    this.name = 'PlanCaseRevisionConflictError';
  }
}

export interface ResearchRepositories {
  readonly workspaceKey: string;
  cases: {
    create(input: CaseCreateRecord): ResearchCaseRevision;
    get(caseId: string, revision?: number): ResearchCaseRevision | null;
    update(input: CaseUpdateRecord): ResearchCaseRevision;
  };
  suggestions: {
    create(claim: string): HypothesisSuggestion;
    exists(suggestionId: string): boolean;
  };
  plans: {
    create(input: PlanCreateRecord): ResearchPlanSnapshot;
    get(planId: string): ResearchPlanSnapshot | null;
  };
  runs: {
    create(input: { caseId: string; caseRevision: number; planId: string }): ResearchRun;
    get(runId: string): ResearchRun | null;
    updateRuntime(runId: string, update: RunRuntimeUpdate, lease: WorkspaceRunLease): ResearchRun;
    saveStep(runId: string, step: ResearchRunStep, lease: WorkspaceRunLease): ResearchRunStep;
    requestCancellation(runId: string, requestedAt?: string): ResearchRun;
  };
  sources: {
    saveVersion(input: SourceVersionInput, lease: WorkspaceRunLease): SourceVersionRecord;
    getVersion(input: Pick<SourceVersionInput, 'sourceItemId' | 'sourceTextHash' | 'retrievedAt'>): SourceVersionRecord | null;
  };
  evidence: {
    save(runId: string, evidence: ResearchEvidence, lease: WorkspaceRunLease): ResearchEvidence;
    list(runId: string): ResearchEvidence[];
  };
  assessments: {
    save(runId: string, assessment: ResearchAssessment, lease: WorkspaceRunLease): ResearchAssessment;
    get(runId: string): ResearchAssessment | null;
  };
  idempotency: {
    /** Execute synchronous local SQLite work only; never run provider I/O here. */
    execute<T>(operation: WriteOperation, key: string, validatedInput: unknown, effect: () => T): { replayed: boolean; value: T };
  };
  externalOperations: {
    /** Reserve before dispatching provider work; the reservation itself is SQLite-only. */
    reserve<T>(input: {
      operation: 'research_plan';
      key: string;
      validatedInput: unknown;
      ownerId: string;
      deadlineAt: string;
    }): ExternalOperationObservation<T>;
    /** Observe without taking over a pending claim. Expired claims become sticky unknown outcomes. */
    observe<T>(operation: 'research_plan', key: string, validatedInput: unknown): ExternalOperationObservation<T>;
    /** Persist result and all callback writes atomically, conditional on the original fencing claim. */
    complete<T>(input: {
      operation: 'research_plan';
      key: string;
      validatedInput: unknown;
      claim: ExternalOperationClaim;
      usage?: ExternalOperationUsage;
      effect: () => T;
    }): { kind: 'completed'; value: T } | { kind: 'unknown' };
    /** Fence off an aborted/owner-lost request without allowing another dispatch. */
    markUnknown(input: {
      operation: 'research_plan';
      key: string;
      validatedInput: unknown;
      claim: ExternalOperationClaim;
      usage?: ExternalOperationUsage;
    }): void;
  };
  leases: {
    acquire(request: LeaseRequest): WorkspaceRunLease;
    /** Atomically recover an expired owner, then assign the next fencing epoch. */
    acquireWithRecovery(request: LeaseRequest): { lease: WorkspaceRunLease; recoveredRunId: string | null };
    /** Mark an expired active run interrupted and clear its lease, preserving the epoch. */
    recoverExpired(): string | null;
    renew(lease: WorkspaceRunLease, ttlMilliseconds: number): WorkspaceRunLease;
    release(lease: WorkspaceRunLease): boolean;
    assertCurrent(lease: WorkspaceRunLease): void;
    withWrite<T>(lease: WorkspaceRunLease, effect: () => T): T;
  };
}

interface CaseRow {
  current_revision: number;
}

interface RunRow {
  run_id: string;
  case_id: string;
  case_revision: number;
  plan_id: string;
  status: RunExecutionStatus;
  snapshot_json: string;
  usage_json: string;
  coverage_gaps_json: string;
  assessment_json: string | null;
  stopping_reason: RunStoppingReason | null;
  created_at_utc: string;
  started_at_utc: string | null;
  finished_at_utc: string | null;
  cancel_requested_at_utc: string | null;
}

interface RunStepRow {
  step_name: ResearchRunStep['name'];
  status: RunStepStatus;
  started_at_utc: string | null;
  finished_at_utc: string | null;
  failure_code: ResearchRunStep['failureCode'];
  provider_availability: ResearchRunStep['providerAvailability'];
}

interface LeaseRow {
  fencing_epoch: number;
  owner_instance_id: string | null;
  run_id: string | null;
  expires_at_utc: string | null;
  renewed_at_utc: string | null;
}

interface ExternalOperationRow {
  input_digest: string;
  status: 'pending' | 'completed' | 'unknown';
  result_json: string | null;
  owner_id: string;
  fencing_epoch: number;
  deadline_at_utc: string;
}

const STEP_ORDER: ResearchRunStep['name'][] = ['search', 'fetch_originals', 'map_evidence', 'assess'];

function nowIso(clock: ResearchClock): string {
  const value = clock();
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('The injected clock must return a valid date');
  return new Date(milliseconds).toISOString();
}

function normalizeIso(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be a valid date`);
  return new Date(milliseconds).toISOString();
}

function requireText(value: string, label: string, maxLength = 4096): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function invokeSynchronous<T>(effect: () => T, label: string): T {
  if (effect.constructor?.name === 'AsyncFunction') {
    throw new TypeError(`${label} must be synchronous local work`);
  }
  const result = effect();
  if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
    throw new TypeError(`${label} must not return a promise or thenable`);
  }
  return result;
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry));
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Canonical JSON must contain only plain objects');
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) result[key] = stableValue(source[key]);
    }
    return result;
  }
  throw new TypeError('Canonical JSON contains an unsupported value');
}

function canonicalJson(value: unknown): string {
  const json = JSON.stringify(stableValue(value));
  if (json === undefined) throw new TypeError('Canonical JSON cannot be undefined');
  return json;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function createDefaultSteps(): ResearchRunStep[] {
  return STEP_ORDER.map((name) => ({
    name,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    failureCode: null,
    providerAvailability: null,
  }));
}

function sourceItemIdFromReference(sourceId: string): number {
  const match = /^source_items:([1-9]\d*)$/.exec(sourceId);
  if (!match) throw new TypeError('Verified evidence must reference a legacy source item ID');
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id)) throw new TypeError('Verified evidence source ID is out of range');
  return id;
}

function validateLeaseTtl(ttlMilliseconds: number): void {
  if (!Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 1 || ttlMilliseconds > 24 * 60 * 60 * 1000) {
    throw new RangeError('Lease duration must be between 1ms and 24 hours');
  }
}

function normalizeRunStep(row: RunStepRow): ResearchRunStep {
  return {
    name: row.step_name,
    status: row.status,
    startedAt: row.started_at_utc,
    finishedAt: row.finished_at_utc,
    failureCode: row.failure_code,
    providerAvailability: row.provider_availability,
  };
}

/**
 * Create a repository set bound to one injected DB and owner workspace. All
 * writes are synchronous SQLite transactions; repositories never close `db`.
 */
export function createResearchRepositories(options: ResearchRepositoryOptions): ResearchRepositories {
  const { db, workspaceKey, clock } = options;
  requireText(workspaceKey, 'workspaceKey', 128);
  if (typeof clock !== 'function') throw new TypeError('An injected clock is required');
  migrateResearchSchema(db);
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  if (foreignKeys !== 1) throw new Error('Research repositories require SQLite foreign-key enforcement');

  const idFactory: ResearchIdFactory = options.idFactory ?? ((kind) => `${kind}_${randomUUID()}`);
  const newId = (kind: ResearchIdKind): string => requireText(idFactory(kind), `${kind} ID`, 128);
  const timestamp = (): string => nowIso(clock);
  const withTransaction = <T>(effect: () => T): T => db.transaction(effect).immediate();

  function readCase(caseId: string, revision?: number): ResearchCaseRevision | null {
    requireText(caseId, 'caseId', 160);
    const row = revision === undefined
      ? db.prepare(`
          SELECT r.snapshot_json
          FROM research_cases c
          JOIN research_case_revisions r
            ON r.workspace_key = c.workspace_key AND r.case_id = c.case_id AND r.revision = c.current_revision
          WHERE c.workspace_key = ? AND c.case_id = ?
        `).get(workspaceKey, caseId) as { snapshot_json: string } | undefined
      : db.prepare('SELECT snapshot_json FROM research_case_revisions WHERE workspace_key = ? AND case_id = ? AND revision = ?')
        .get(workspaceKey, caseId, revision) as { snapshot_json: string } | undefined;
    return row ? parseJson<ResearchCaseRevision>(row.snapshot_json) : null;
  }

  function readRunRow(runId: string): RunRow | undefined {
    return db.prepare('SELECT * FROM research_runs WHERE workspace_key = ? AND run_id = ?')
      .get(workspaceKey, runId) as RunRow | undefined;
  }

  function requireRunRow(runId: string): RunRow {
    const row = readRunRow(runId);
    if (!row) throw new RepositoryNotFoundError('run', runId);
    return row;
  }

  function readRunSteps(runId: string): ResearchRunStep[] {
    const rows = db.prepare(`
      SELECT step_name, status, started_at_utc, finished_at_utc, failure_code, provider_availability
      FROM research_run_steps WHERE workspace_key = ? AND run_id = ?
    `).all(workspaceKey, runId) as RunStepRow[];
    const byName = new Map(rows.map((row) => [row.step_name, normalizeRunStep(row)]));
    return STEP_ORDER.map((name) => byName.get(name) ?? createDefaultSteps().find((step) => step.name === name)!);
  }

  function readRun(runId: string): ResearchRun | null {
    const row = readRunRow(runId);
    if (!row) return null;
    const snapshot = parseJson<ResearchCaseRunSnapshot>(row.snapshot_json);
    const assessment = row.assessment_json ? parseJson<ResearchAssessment>(row.assessment_json) : null;
    return {
      runId: row.run_id,
      caseId: row.case_id,
      caseRevision: row.case_revision,
      planId: row.plan_id,
      status: row.status,
      snapshot,
      steps: readRunSteps(runId),
      usage: parseJson<ResearchUsage>(row.usage_json),
      assessment,
      coverageGaps: parseJson<CoverageGap[]>(row.coverage_gaps_json),
      stoppingReason: row.stopping_reason,
      createdAt: row.created_at_utc,
      startedAt: row.started_at_utc,
      finishedAt: row.finished_at_utc,
      cancelRequestedAt: row.cancel_requested_at_utc,
    };
  }

  function assertLeaseCurrent(lease: WorkspaceRunLease): void {
    if (lease.workspaceKey !== workspaceKey) throw new StaleWorkspaceLeaseError();
    const now = timestamp();
    const row = db.prepare(`
      SELECT 1 AS current
      FROM research_workspace_leases
      WHERE workspace_key = ? AND run_id = ? AND owner_instance_id = ?
        AND fencing_epoch = ? AND expires_at_utc > ?
    `).get(workspaceKey, lease.runId, lease.ownerInstanceId, lease.fencingToken, now) as { current: number } | undefined;
    if (!row) throw new StaleWorkspaceLeaseError();
  }

  function recoverExpiredLeaseInTransaction(): string | null {
    const now = timestamp();
    const lease = db.prepare('SELECT * FROM research_workspace_leases WHERE workspace_key = ?')
      .get(workspaceKey) as LeaseRow | undefined;
    if (!lease?.owner_instance_id || !lease.run_id || !lease.expires_at_utc || lease.expires_at_utc > now) return null;

    const run = readRun(lease.run_id);
    if (run && ['queued', 'running', 'cancellation_requested'].includes(run.status)) {
      const coverageGaps = run.coverageGaps.some((gap) => gap.reason === 'interrupted')
        ? run.coverageGaps
        : [...run.coverageGaps, {
            reason: 'interrupted' as const,
            detail: 'The run owner lease expired before the run completed.',
            queryId: null,
            hypothesisId: null,
          }];
      db.prepare(`
        UPDATE research_runs
        SET status = 'interrupted', stopping_reason = 'lease_lost', finished_at_utc = ?, coverage_gaps_json = ?, usage_json = ?
        WHERE workspace_key = ? AND run_id = ? AND status IN ('queued', 'running', 'cancellation_requested')
      `).run(now, canonicalJson(coverageGaps), canonicalJson({
        ...run.usage,
        modelInputTokens: null,
        modelOutputTokens: null,
        providerCostMicros: null,
        elapsedMilliseconds: Math.max(0, Date.parse(now) - Date.parse(run.createdAt)),
      }), workspaceKey, run.runId);
      db.prepare(`
        UPDATE research_run_steps SET status = 'cancelled', finished_at_utc = ?
        WHERE workspace_key = ? AND run_id = ? AND status = 'running'
      `).run(now, workspaceKey, run.runId);
    }

    const cleared = db.prepare(`
      UPDATE research_workspace_leases
      SET owner_instance_id = NULL, run_id = NULL, expires_at_utc = NULL, renewed_at_utc = NULL
      WHERE workspace_key = ? AND fencing_epoch = ? AND owner_instance_id = ? AND run_id = ? AND expires_at_utc <= ?
    `).run(workspaceKey, lease.fencing_epoch, lease.owner_instance_id, lease.run_id, now);
    return cleared.changes === 1 ? lease.run_id : null;
  }

  function acquireLeaseInTransaction(request: LeaseRequest): WorkspaceRunLease {
    if (!readRunRow(request.runId)) throw new RepositoryNotFoundError('run', request.runId);
    const now = timestamp();
    const row = db.prepare('SELECT * FROM research_workspace_leases WHERE workspace_key = ?')
      .get(workspaceKey) as LeaseRow | undefined;
    if (row?.owner_instance_id && row.expires_at_utc && row.expires_at_utc > now) {
      throw new ActiveWorkspaceLeaseError(row.run_id!);
    }
    const fencingToken = (row?.fencing_epoch ?? 0) + 1;
    const expiresAt = new Date(Date.parse(now) + request.ttlMilliseconds).toISOString();
    db.prepare(`
      INSERT INTO research_workspace_leases(workspace_key, fencing_epoch, owner_instance_id, run_id, expires_at_utc, renewed_at_utc)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_key) DO UPDATE SET
        fencing_epoch = excluded.fencing_epoch,
        owner_instance_id = excluded.owner_instance_id,
        run_id = excluded.run_id,
        expires_at_utc = excluded.expires_at_utc,
        renewed_at_utc = excluded.renewed_at_utc
    `).run(workspaceKey, fencingToken, request.ownerInstanceId, request.runId, expiresAt, now);
    return { workspaceKey, runId: request.runId, ownerInstanceId: request.ownerInstanceId, fencingToken, expiresAt, renewedAt: now };
  }

  function observeExternalOperation<T>(
    operation: 'research_plan',
    key: string,
    inputDigest: string,
  ): ExternalOperationObservation<T> {
    const receipt = db.prepare(`
      SELECT input_digest, result_json FROM research_idempotency_receipts
      WHERE workspace_key = ? AND operation = ? AND idempotency_key = ?
    `).get(workspaceKey, operation, key) as { input_digest: string; result_json: string } | undefined;
    if (receipt) {
      if (receipt.input_digest !== inputDigest) throw new IdempotencyConflictError(operation);
      return { kind: 'replay', value: parseJson<T>(receipt.result_json) };
    }

    const row = db.prepare(`
      SELECT input_digest, status, result_json, owner_id, fencing_epoch, deadline_at_utc
      FROM research_external_operations
      WHERE workspace_key = ? AND operation = ? AND idempotency_key = ?
    `).get(workspaceKey, operation, key) as ExternalOperationRow | undefined;
    if (!row) return { kind: 'absent' };
    if (row.input_digest !== inputDigest) throw new IdempotencyConflictError(operation);
    if (row.status === 'pending' && row.deadline_at_utc <= timestamp()) {
      db.prepare(`
        UPDATE research_external_operations SET status = 'unknown', updated_at_utc = ?
        WHERE workspace_key = ? AND operation = ? AND idempotency_key = ? AND status = 'pending'
      `).run(timestamp(), workspaceKey, operation, key);
      return { kind: 'unknown' };
    }
    if (row.status === 'completed') {
      if (row.result_json === null) throw new Error('Completed external operation has no result');
      return { kind: 'replay', value: parseJson<T>(row.result_json) };
    }
    if (row.status === 'unknown') return { kind: 'unknown' };
    return {
      kind: 'pending',
      ownerId: row.owner_id,
      fencingToken: row.fencing_epoch,
      deadlineAt: row.deadline_at_utc,
    };
  }

  function runHypothesisRevision(runId: string, hypothesisId: string): number | null {
    const row = db.prepare(`
      SELECT hypothesis_revision FROM research_run_hypotheses
      WHERE workspace_key = ? AND run_id = ? AND hypothesis_id = ?
    `).get(workspaceKey, runId, hypothesisId) as { hypothesis_revision: number } | undefined;
    return row?.hypothesis_revision ?? null;
  }

  const repositories: ResearchRepositories = {
    workspaceKey,
    cases: {
      create(input): ResearchCaseRevision {
        return withTransaction(() => {
          const caseId = newId('case');
          const createdAt = timestamp();
          const intake = input.intake ? parseJson<ResearchIntake>(canonicalJson(input.intake)) : {};
          db.prepare(`
            INSERT INTO research_cases(workspace_key, case_id, current_revision, created_at_utc, updated_at_utc)
            VALUES (?, ?, 1, ?, ?)
          `).run(workspaceKey, caseId, createdAt, createdAt);

          const hypotheses: HypothesisRevision[] = [];
          for (const submission of input.hypotheses ?? []) {
            const hypothesisId = newId('hypothesis');
            const origin = submission.origin ?? 'user_supplied';
            const sourceSuggestionId = origin === 'model_suggested' && 'sourceSuggestionId' in submission
              ? submission.sourceSuggestionId
              : null;
            if (origin === 'model_suggested' && !sourceSuggestionId) throw new TypeError('Suggested hypotheses require suggestion provenance');
            if (origin === 'model_suggested') {
              const found = db.prepare(`SELECT 1 FROM research_hypothesis_suggestions WHERE workspace_key = ? AND suggestion_id = ?`)
                .get(workspaceKey, sourceSuggestionId) as unknown;
              if (!found) throw new RepositoryNotFoundError('suggestion', sourceSuggestionId!);
            }
            const claim = requireText(submission.claim, 'hypothesis claim', 1000);
            db.prepare(`
              INSERT INTO research_hypotheses(workspace_key, case_id, hypothesis_id, current_revision, created_at_utc)
              VALUES (?, ?, ?, 1, ?)
            `).run(workspaceKey, caseId, hypothesisId, createdAt);
            db.prepare(`
              INSERT INTO research_hypothesis_revisions(
                workspace_key, case_id, hypothesis_id, revision, claim, origin, source_suggestion_id, state, created_at_utc
              ) VALUES (?, ?, ?, 1, ?, ?, ?, 'active', ?)
            `).run(workspaceKey, caseId, hypothesisId, claim, origin, sourceSuggestionId, createdAt);
            hypotheses.push({ hypothesisId, revision: 1, claim, origin, sourceSuggestionId, state: 'active', createdAt });
          }

          const result: ResearchCaseRevision = { caseId, revision: 1, intake, hypothesisRevisions: hypotheses, createdAt };
          db.prepare(`
            INSERT INTO research_case_revisions(workspace_key, case_id, revision, intake_json, snapshot_json, created_at_utc)
            VALUES (?, ?, 1, ?, ?, ?)
          `).run(workspaceKey, caseId, canonicalJson(intake), canonicalJson(result), createdAt);
          return result;
        });
      },

      get(caseId, revision): ResearchCaseRevision | null {
        return readCase(caseId, revision);
      },

      update(input): ResearchCaseRevision {
        return withTransaction(() => {
          const mutationTargets = (input.hypothesisMutations ?? []).map((mutation) =>
            mutation.operation === 'add' ? `new:${mutation.clientRef}` : mutation.hypothesisId,
          );
          if (new Set(mutationTargets).size !== mutationTargets.length) throw new TypeError('A case update may mutate each hypothesis only once');
          const caseRow = db.prepare('SELECT current_revision FROM research_cases WHERE workspace_key = ? AND case_id = ?')
            .get(workspaceKey, input.caseId) as CaseRow | undefined;
          if (!caseRow) throw new RepositoryNotFoundError('case', input.caseId);
          if (caseRow.current_revision !== input.expectedRevision) {
            throw new CaseRevisionConflictError(input.caseId, input.expectedRevision, caseRow.current_revision);
          }
          const current = readCase(input.caseId);
          if (!current) throw new RepositoryNotFoundError('case', input.caseId);
          const createdAt = timestamp();
          const intake: ResearchIntake = {
            ...current.intake,
            ...(input.intakePatch ? parseJson<ResearchIntake>(canonicalJson(input.intakePatch)) : {}),
          };
          const hypotheses = [...current.hypothesisRevisions];

          for (const mutation of input.hypothesisMutations ?? []) {
            if (mutation.operation === 'add') {
              const hypothesisId = newId('hypothesis');
              const origin = mutation.origin ?? 'user_supplied';
              const sourceSuggestionId = origin === 'model_suggested' && 'sourceSuggestionId' in mutation
                ? mutation.sourceSuggestionId
                : null;
              if (origin === 'model_suggested' && !sourceSuggestionId) throw new TypeError('Suggested hypotheses require suggestion provenance');
              if (origin === 'model_suggested') {
                const found = db.prepare('SELECT 1 FROM research_hypothesis_suggestions WHERE workspace_key = ? AND suggestion_id = ?')
                  .get(workspaceKey, sourceSuggestionId) as unknown;
                if (!found) throw new RepositoryNotFoundError('suggestion', sourceSuggestionId!);
              }
              const claim = requireText(mutation.claim, 'hypothesis claim', 1000);
              db.prepare(`
                INSERT INTO research_hypotheses(workspace_key, case_id, hypothesis_id, current_revision, created_at_utc)
                VALUES (?, ?, ?, 1, ?)
              `).run(workspaceKey, input.caseId, hypothesisId, createdAt);
              db.prepare(`
                INSERT INTO research_hypothesis_revisions(
                  workspace_key, case_id, hypothesis_id, revision, claim, origin, source_suggestion_id, state, created_at_utc
                ) VALUES (?, ?, ?, 1, ?, ?, ?, 'active', ?)
              `).run(workspaceKey, input.caseId, hypothesisId, claim, origin, sourceSuggestionId, createdAt);
              hypotheses.push({ hypothesisId, revision: 1, claim, origin, sourceSuggestionId, state: 'active', createdAt });
              continue;
            }

            const existingIndex = hypotheses.findIndex((item) => item.hypothesisId === mutation.hypothesisId);
            if (existingIndex < 0) throw new RepositoryNotFoundError('hypothesis', mutation.hypothesisId);
            const existing = hypotheses[existingIndex];
            if (existing.revision !== mutation.expectedRevision) {
              throw new HypothesisRevisionConflictError(mutation.hypothesisId, mutation.expectedRevision, existing.revision);
            }
            if (mutation.operation === 'retire' && existing.state === 'retired') {
              throw new TypeError('A retired hypothesis cannot be retired again');
            }
            const nextRevision = existing.revision + 1;
            const next: HypothesisRevision = {
              ...existing,
              revision: nextRevision,
              claim: mutation.operation === 'revise' ? requireText(mutation.claim, 'hypothesis claim', 1000) : existing.claim,
              state: mutation.operation === 'retire' ? 'retired' : existing.state,
              createdAt,
            };
            db.prepare(`
              INSERT INTO research_hypothesis_revisions(
                workspace_key, case_id, hypothesis_id, revision, claim, origin, source_suggestion_id, state, created_at_utc
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(workspaceKey, input.caseId, next.hypothesisId, next.revision, next.claim, next.origin, next.sourceSuggestionId, next.state, createdAt);
            db.prepare(`
              UPDATE research_hypotheses SET current_revision = ?
              WHERE workspace_key = ? AND case_id = ? AND hypothesis_id = ? AND current_revision = ?
            `).run(nextRevision, workspaceKey, input.caseId, next.hypothesisId, existing.revision);
            hypotheses[existingIndex] = next;
          }

          const nextCaseRevision = current.revision + 1;
          const updated = db.prepare(`
            UPDATE research_cases SET current_revision = ?, updated_at_utc = ?
            WHERE workspace_key = ? AND case_id = ? AND current_revision = ?
          `).run(nextCaseRevision, createdAt, workspaceKey, input.caseId, current.revision);
          if (updated.changes !== 1) throw new CaseRevisionConflictError(input.caseId, input.expectedRevision, current.revision + 1);
          const result: ResearchCaseRevision = {
            caseId: input.caseId,
            revision: nextCaseRevision,
            intake,
            hypothesisRevisions: hypotheses,
            createdAt,
          };
          db.prepare(`
            INSERT INTO research_case_revisions(workspace_key, case_id, revision, intake_json, snapshot_json, created_at_utc)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(workspaceKey, input.caseId, nextCaseRevision, canonicalJson(intake), canonicalJson(result), createdAt);
          return result;
        });
      },
    },

    suggestions: {
      create(claim): HypothesisSuggestion {
        const suggestion: HypothesisSuggestion = {
          suggestionId: newId('suggestion'),
          claim: requireText(claim, 'suggestion claim', 1000),
          origin: 'model_suggested',
          status: 'unaccepted_suggestion',
        };
        db.prepare(`
          INSERT INTO research_hypothesis_suggestions(workspace_key, suggestion_id, claim, created_at_utc)
          VALUES (?, ?, ?, ?)
        `).run(workspaceKey, suggestion.suggestionId, suggestion.claim, timestamp());
        return suggestion;
      },
      exists(suggestionId): boolean {
        return Boolean(db.prepare('SELECT 1 FROM research_hypothesis_suggestions WHERE workspace_key = ? AND suggestion_id = ?')
          .get(workspaceKey, suggestionId));
      },
    },

    plans: {
      create(input): ResearchPlanSnapshot {
        return withTransaction(() => {
          const caseRevision = readCase(input.caseId, input.caseRevision);
          if (!caseRevision) throw new RepositoryNotFoundError('case revision', `${input.caseId}:${input.caseRevision}`);
          const currentRow = db.prepare('SELECT current_revision FROM research_cases WHERE workspace_key = ? AND case_id = ?')
            .get(workspaceKey, input.caseId) as CaseRow | undefined;
          if (!currentRow) throw new RepositoryNotFoundError('case', input.caseId);
          if (currentRow.current_revision !== input.caseRevision) {
            throw new PlanCaseRevisionConflictError(input.caseId, input.caseRevision, currentRow.current_revision);
          }

          const activeHypotheses = new Map(caseRevision.hypothesisRevisions
            .filter((hypothesis) => hypothesis.state === 'active')
            .map((hypothesis) => [hypothesis.hypothesisId, hypothesis]));
          const planId = newId('plan');
          const createdAt = timestamp();
          const queries: ResearchQuery[] = input.queries.map((query, index) => ({
            ...query,
            queryId: query.queryId === undefined
              ? `q_${hashText(planId).slice(0, 20)}_${index + 1}`
              : requireText(query.queryId, 'queryId', 128),
          }));
          if (new Set(queries.map((query) => query.queryId)).size !== queries.length) throw new TypeError('Plan query IDs must be unique');
          for (const query of queries) {
            for (const hypothesisId of query.hypothesisIds) {
              if (!activeHypotheses.has(hypothesisId)) throw new RepositoryNotFoundError('active hypothesis', hypothesisId);
            }
          }
          const plan: ResearchPlanSnapshot = {
            planId,
            caseId: input.caseId,
            caseRevision: input.caseRevision,
            queries,
            limits: parseJson<ResearchPlanSnapshot['limits']>(canonicalJson(input.limits)),
            createdAt,
          };
          db.prepare(`
            INSERT INTO research_plans(workspace_key, plan_id, case_id, case_revision, payload_json, created_at_utc)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(workspaceKey, planId, input.caseId, input.caseRevision, canonicalJson(plan), createdAt);

          for (const query of queries) {
            db.prepare(`
              INSERT INTO research_plan_queries(
                workspace_key, plan_id, case_id, case_revision, query_id, query_text, purpose, evidence_intent, source_scopes_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(workspaceKey, planId, input.caseId, input.caseRevision, query.queryId, query.text, query.purpose, query.evidenceIntent, canonicalJson(query.sourceScopes));
            for (const hypothesisId of query.hypothesisIds) {
              const hypothesis = activeHypotheses.get(hypothesisId)!;
              db.prepare(`
                INSERT INTO research_plan_query_hypotheses(workspace_key, plan_id, case_id, query_id, hypothesis_id, hypothesis_revision)
                VALUES (?, ?, ?, ?, ?, ?)
              `).run(workspaceKey, planId, input.caseId, query.queryId, hypothesisId, hypothesis.revision);
            }
          }
          return plan;
        });
      },
      get(planId): ResearchPlanSnapshot | null {
        const row = db.prepare('SELECT payload_json FROM research_plans WHERE workspace_key = ? AND plan_id = ?')
          .get(workspaceKey, planId) as { payload_json: string } | undefined;
        return row ? parseJson<ResearchPlanSnapshot>(row.payload_json) : null;
      },
    },

    runs: {
      create(input): ResearchRun {
        return withTransaction(() => {
          const caseRevision = readCase(input.caseId, input.caseRevision);
          if (!caseRevision) throw new RepositoryNotFoundError('case revision', `${input.caseId}:${input.caseRevision}`);
          const currentCase = db.prepare('SELECT current_revision FROM research_cases WHERE workspace_key = ? AND case_id = ?')
            .get(workspaceKey, input.caseId) as CaseRow | undefined;
          if (!currentCase) throw new RepositoryNotFoundError('case', input.caseId);
          if (currentCase.current_revision !== input.caseRevision) {
            throw new PlanCaseRevisionConflictError(input.caseId, input.caseRevision, currentCase.current_revision);
          }
          const planRow = db.prepare('SELECT payload_json, case_id, case_revision FROM research_plans WHERE workspace_key = ? AND plan_id = ?')
            .get(workspaceKey, input.planId) as { payload_json: string; case_id: string; case_revision: number } | undefined;
          if (!planRow) throw new RepositoryNotFoundError('plan', input.planId);
          if (planRow.case_id !== input.caseId || planRow.case_revision !== input.caseRevision) {
            throw new PlanCaseRevisionConflictError(input.caseId, input.caseRevision, planRow.case_revision);
          }
          const plan = parseJson<ResearchPlanSnapshot>(planRow.payload_json);
          const snapshot: ResearchCaseRunSnapshot = { caseRevision, plan };
          const runId = newId('run');
          const createdAt = timestamp();
          const steps = createDefaultSteps();
          const usage: ResearchUsage = {
            searchRequests: 0,
            fetchedPages: 0,
            modelInputTokens: null,
            modelOutputTokens: null,
            providerCostMicros: null,
            elapsedMilliseconds: 0,
          };
          db.prepare(`
            INSERT INTO research_runs(
              workspace_key, run_id, case_id, case_revision, plan_id, status, snapshot_json, usage_json,
              coverage_gaps_json, assessment_json, stopping_reason, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, '[]', NULL, NULL, ?)
          `).run(workspaceKey, runId, input.caseId, input.caseRevision, input.planId, canonicalJson(snapshot), canonicalJson(usage), createdAt);
          for (const hypothesis of caseRevision.hypothesisRevisions.filter((item) => item.state === 'active')) {
            db.prepare(`
              INSERT INTO research_run_hypotheses(workspace_key, run_id, case_id, hypothesis_id, hypothesis_revision)
              VALUES (?, ?, ?, ?, ?)
            `).run(workspaceKey, runId, input.caseId, hypothesis.hypothesisId, hypothesis.revision);
          }
          for (const step of steps) {
            db.prepare(`
              INSERT INTO research_run_steps(workspace_key, run_id, case_id, step_name, status, started_at_utc, finished_at_utc, failure_code, provider_availability)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
            `).run(workspaceKey, runId, input.caseId, step.name, step.status);
          }
          return {
            runId,
            caseId: input.caseId,
            caseRevision: input.caseRevision,
            planId: input.planId,
            status: 'queued',
            snapshot,
            steps,
            usage,
            assessment: null,
            coverageGaps: [],
            stoppingReason: null,
            createdAt,
            startedAt: null,
            finishedAt: null,
            cancelRequestedAt: null,
          };
        });
      },
      get(runId): ResearchRun | null {
        return readRun(runId);
      },
      updateRuntime(runId, update, lease): ResearchRun {
        return repositories.leases.withWrite(lease, () => {
          const row = requireRunRow(runId);
          if (lease.runId !== runId) throw new StaleWorkspaceLeaseError();
          const current = readRun(runId);
          if (!current) throw new RepositoryNotFoundError('run', runId);
          if (update.status !== undefined &&
              ['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status) &&
              update.status !== current.status) return current;
          if (current.status === 'cancellation_requested' &&
              update.status !== undefined && update.status !== 'cancelled') return current;
          const fields: string[] = [];
          const values: unknown[] = [];
          const assignJson = (column: string, value: unknown): void => {
            fields.push(`${column} = ?`);
            values.push(canonicalJson(value));
          };
          const assign = (column: string, value: unknown): void => {
            fields.push(`${column} = ?`);
            values.push(value);
          };
          if (update.status !== undefined) assign('status', update.status);
          if (update.usage !== undefined) assignJson('usage_json', update.usage);
          if (update.coverageGaps !== undefined) assignJson('coverage_gaps_json', update.coverageGaps);
          if (update.stoppingReason !== undefined) assign('stopping_reason', update.stoppingReason);
          if (update.startedAt !== undefined) assign('started_at_utc', update.startedAt === null ? null : normalizeIso(update.startedAt, 'startedAt'));
          if (update.finishedAt !== undefined) assign('finished_at_utc', update.finishedAt === null ? null : normalizeIso(update.finishedAt, 'finishedAt'));
          if (update.cancelRequestedAt !== undefined) assign('cancel_requested_at_utc', update.cancelRequestedAt === null ? null : normalizeIso(update.cancelRequestedAt, 'cancelRequestedAt'));
          if (fields.length) {
            values.push(workspaceKey, runId, row.case_id);
            db.prepare(`UPDATE research_runs SET ${fields.join(', ')} WHERE workspace_key = ? AND run_id = ? AND case_id = ?`).run(...values);
          }
          const result = readRun(runId);
          if (!result) throw new RepositoryNotFoundError('run', runId);
          return result;
        });
      },
      saveStep(runId, step, lease): ResearchRunStep {
        return repositories.leases.withWrite(lease, () => {
          const row = requireRunRow(runId);
          if (lease.runId !== runId) throw new StaleWorkspaceLeaseError();
          db.prepare(`
            INSERT INTO research_run_steps(
              workspace_key, run_id, case_id, step_name, status, started_at_utc, finished_at_utc, failure_code, provider_availability
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(workspace_key, run_id, step_name) DO UPDATE SET
              status = excluded.status,
              started_at_utc = excluded.started_at_utc,
              finished_at_utc = excluded.finished_at_utc,
              failure_code = excluded.failure_code,
              provider_availability = excluded.provider_availability
          `).run(
            workspaceKey,
            runId,
            row.case_id,
            step.name,
            step.status,
            step.startedAt === null ? null : normalizeIso(step.startedAt, 'step.startedAt'),
            step.finishedAt === null ? null : normalizeIso(step.finishedAt, 'step.finishedAt'),
            step.failureCode,
            step.providerAvailability,
          );
          return { ...step };
        });
      },
      requestCancellation(runId, requestedAt = timestamp()): ResearchRun {
        return withTransaction(() => {
          const row = requireRunRow(runId);
          const current = readRun(runId)!;
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) return current;
          if (current.status === 'cancellation_requested') return current;
          const normalizedAt = normalizeIso(requestedAt, 'requestedAt');
          const updated = db.prepare(`
            UPDATE research_runs
            SET status = 'cancellation_requested', cancel_requested_at_utc = COALESCE(cancel_requested_at_utc, ?)
            WHERE workspace_key = ? AND run_id = ? AND case_id = ?
              AND status IN ('queued', 'running')
          `).run(normalizedAt, workspaceKey, runId, row.case_id);
          if (updated.changes !== 1) return readRun(runId)!;
          return readRun(runId)!;
        });
      },
    },

    sources: {
      saveVersion(input, lease): SourceVersionRecord {
        return repositories.leases.withWrite(lease, () => {
          if (input.runId !== lease.runId) throw new StaleWorkspaceLeaseError();
          const run = requireRunRow(input.runId);
          if (hashText(input.sourceText) !== input.sourceTextHash) throw new TypeError('Source text hash does not match the fetched original');
          if (!Number.isSafeInteger(input.sourceItemId) || input.sourceItemId < 1) throw new TypeError('sourceItemId must be a positive integer');
          const retrievedAt = normalizeIso(input.retrievedAt, 'retrievedAt');
          requireText(input.canonicalUrl, 'canonicalUrl', 4096);
          const sourceItem = db.prepare('SELECT 1 FROM source_items WHERE id = ?').get(input.sourceItemId) as unknown;
          if (!sourceItem) throw new RepositoryNotFoundError('source item', String(input.sourceItemId));
          const existing = db.prepare(`
            SELECT canonical_url, body_text FROM research_source_versions
            WHERE workspace_key = ? AND source_item_id = ? AND source_text_hash = ? AND retrieved_at_utc = ?
          `).get(workspaceKey, input.sourceItemId, input.sourceTextHash, retrievedAt) as { canonical_url: string; body_text: string } | undefined;
          if (existing) {
            if (existing.canonical_url !== input.canonicalUrl || existing.body_text !== input.sourceText) {
              throw new ImmutableRecordConflictError('source version', `${input.sourceItemId}:${input.sourceTextHash}`);
            }
          } else {
            db.prepare(`
              INSERT INTO research_source_versions(workspace_key, source_item_id, source_text_hash, retrieved_at_utc, canonical_url, body_text)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(workspaceKey, input.sourceItemId, input.sourceTextHash, retrievedAt, input.canonicalUrl, input.sourceText);
          }
          // Ensure a source cannot be smuggled in through a lease for another run.
          if (!run.run_id) throw new RepositoryNotFoundError('run', input.runId);
          return {
            workspaceKey,
            sourceItemId: input.sourceItemId,
            sourceTextHash: input.sourceTextHash,
            canonicalUrl: input.canonicalUrl,
            sourceText: input.sourceText,
            retrievedAt,
          };
        });
      },
      getVersion(input): SourceVersionRecord | null {
        const row = db.prepare(`
          SELECT source_item_id, source_text_hash, retrieved_at_utc, canonical_url, body_text
          FROM research_source_versions
          WHERE workspace_key = ? AND source_item_id = ? AND source_text_hash = ? AND retrieved_at_utc = ?
        `).get(workspaceKey, input.sourceItemId, input.sourceTextHash, normalizeIso(input.retrievedAt, 'retrievedAt')) as {
          source_item_id: number; source_text_hash: string; retrieved_at_utc: string; canonical_url: string; body_text: string;
        } | undefined;
        return row ? {
          workspaceKey,
          sourceItemId: row.source_item_id,
          sourceTextHash: row.source_text_hash,
          canonicalUrl: row.canonical_url,
          sourceText: row.body_text,
          retrievedAt: row.retrieved_at_utc,
        } : null;
      },
    },

    evidence: {
      save(runId, evidence, lease): ResearchEvidence {
        return repositories.leases.withWrite(lease, () => {
          const row = requireRunRow(runId);
          if (lease.runId !== runId) throw new StaleWorkspaceLeaseError();
          const evidenceId = evidence.kind === 'verified_excerpt' ? evidence.evidenceId : evidence.snippetId;
          requireText(evidenceId, 'evidenceId', 128);
          const payload = canonicalJson(evidence);
          const existing = db.prepare('SELECT payload_json FROM research_evidence WHERE workspace_key = ? AND run_id = ? AND evidence_id = ?')
            .get(workspaceKey, runId, evidenceId) as { payload_json: string } | undefined;
          if (existing) {
            if (existing.payload_json !== payload) throw new ImmutableRecordConflictError('evidence', evidenceId);
            return parseJson<ResearchEvidence>(existing.payload_json);
          }
          if (evidence.kind === 'verified_excerpt') {
            requireText(evidence.hypothesisId, 'hypothesisId', 128);
            requireText(evidence.independenceGroupId, 'independenceGroupId', 160);
            requireText(evidence.interpretation, 'interpretation', 2000);
            if (evidence.independenceUncertain !== undefined && typeof evidence.independenceUncertain !== 'boolean') {
              throw new TypeError('independenceUncertain must be a boolean when supplied');
            }
            if (evidence.verification !== 'matched_to_fetched_original') throw new TypeError('Verified evidence must be grounded in a fetched original');
            const sourceItemId = sourceItemIdFromReference(evidence.source.sourceId);
            const retrievedAt = normalizeIso(evidence.source.retrievedAt, 'evidence.source.retrievedAt');
            if (evidence.excerpt.sourceItemId !== sourceItemId) throw new TypeError('Evidence source ID must match its excerpt');
            const version = db.prepare(`
              SELECT canonical_url, body_text FROM research_source_versions
              WHERE workspace_key = ? AND source_item_id = ? AND source_text_hash = ? AND retrieved_at_utc = ?
            `).get(workspaceKey, sourceItemId, evidence.excerpt.sourceTextHash, retrievedAt) as { canonical_url: string; body_text: string } | undefined;
            if (!version) throw new RepositoryNotFoundError('source version', `${sourceItemId}:${evidence.excerpt.sourceTextHash}`);
            if (version.canonical_url !== evidence.source.canonicalUrl || !verifyResearchExcerpt({
              sourceItemId,
              sourceText: version.body_text,
              excerpt: evidence.excerpt,
            })) throw new TypeError('Verified excerpt does not match the immutable fetched original');
            if (runHypothesisRevision(runId, evidence.hypothesisId) === null) {
              throw new RepositoryNotFoundError('run hypothesis', evidence.hypothesisId);
            }
            db.prepare(`
              INSERT INTO research_evidence(
                workspace_key, run_id, case_id, evidence_id, evidence_kind, hypothesis_id, relationship,
                source_item_id, source_text_hash, retrieved_at_utc, payload_json
              ) VALUES (?, ?, ?, ?, 'verified_excerpt', ?, ?, ?, ?, ?, ?)
            `).run(workspaceKey, runId, row.case_id, evidence.evidenceId, evidence.hypothesisId, evidence.relationship, sourceItemId, evidence.excerpt.sourceTextHash, retrievedAt, payload);
          } else {
            requireText(evidence.queryId, 'queryId', 128);
            requireText(evidence.sourceUrl, 'sourceUrl', 4096);
            requireText(evidence.text, 'snippet text', 4096);
            if (evidence.assessmentEligible !== false) throw new TypeError('Search snippets are never assessment eligible');
            const run = readRun(runId)!;
            if (!run.snapshot.plan.queries.some((query) => query.queryId === evidence.queryId)) {
              throw new RepositoryNotFoundError('run query', evidence.queryId);
            }
            db.prepare(`
              INSERT INTO research_evidence(
                workspace_key, run_id, case_id, evidence_id, evidence_kind, hypothesis_id, relationship,
                source_item_id, source_text_hash, retrieved_at_utc, payload_json
              ) VALUES (?, ?, ?, ?, 'search_snippet', NULL, NULL, NULL, NULL, NULL, ?)
            `).run(workspaceKey, runId, row.case_id, evidence.snippetId, payload);
          }
          return parseJson<ResearchEvidence>(payload);
        });
      },
      list(runId): ResearchEvidence[] {
        if (!readRunRow(runId)) throw new RepositoryNotFoundError('run', runId);
        const rows = db.prepare(`
          SELECT payload_json FROM research_evidence WHERE workspace_key = ? AND run_id = ? ORDER BY evidence_id
        `).all(workspaceKey, runId) as Array<{ payload_json: string }>;
        return rows.map((row) => parseJson<ResearchEvidence>(row.payload_json));
      },
    },

    assessments: {
      save(runId, assessment, lease): ResearchAssessment {
        return repositories.leases.withWrite(lease, () => {
          const row = requireRunRow(runId);
          if (lease.runId !== runId) throw new StaleWorkspaceLeaseError();
          const payload = canonicalJson(assessment);
          const existing = db.prepare('SELECT payload_json FROM research_assessments WHERE workspace_key = ? AND run_id = ?')
            .get(workspaceKey, runId) as { payload_json: string } | undefined;
          if (existing) {
            if (existing.payload_json !== payload) throw new ImmutableRecordConflictError('assessment', runId);
            return parseJson<ResearchAssessment>(existing.payload_json);
          }

          db.prepare(`
            INSERT INTO research_assessments(workspace_key, run_id, case_id, payload_json, created_at_utc)
            VALUES (?, ?, ?, ?, ?)
          `).run(workspaceKey, runId, row.case_id, payload, timestamp());
          for (const claim of assessment.claims) {
            if (runHypothesisRevision(runId, claim.hypothesisId) === null) {
              throw new RepositoryNotFoundError('run hypothesis', claim.hypothesisId);
            }
            db.prepare(`
              INSERT INTO research_assessment_claims(workspace_key, run_id, case_id, hypothesis_id, outcome, payload_json)
              VALUES (?, ?, ?, ?, ?, ?)
            `).run(workspaceKey, runId, row.case_id, claim.hypothesisId, claim.outcome, canonicalJson(claim));
            for (const evidenceId of claim.supportingEvidenceIds) {
              insertAssessmentEvidenceRef(runId, row.case_id, claim.hypothesisId, evidenceId, 'supports');
            }
            for (const evidenceId of claim.challengingEvidenceIds) {
              insertAssessmentEvidenceRef(runId, row.case_id, claim.hypothesisId, evidenceId, 'contradicts');
            }
          }
          db.prepare('UPDATE research_runs SET assessment_json = ? WHERE workspace_key = ? AND run_id = ?')
            .run(payload, workspaceKey, runId);
          return parseJson<ResearchAssessment>(payload);
        });
      },
      get(runId): ResearchAssessment | null {
        const row = db.prepare('SELECT payload_json FROM research_assessments WHERE workspace_key = ? AND run_id = ?')
          .get(workspaceKey, runId) as { payload_json: string } | undefined;
        return row ? parseJson<ResearchAssessment>(row.payload_json) : null;
      },
    },

    externalOperations: {
      reserve<T>(input): ExternalOperationObservation<T> {
        requireText(input.key, 'idempotency key', 200);
        requireText(input.ownerId, 'external operation owner', 200);
        const inputDigest = hashText(canonicalJson(input.validatedInput));
        const deadlineAt = normalizeIso(input.deadlineAt, 'external operation deadline');
        return withTransaction(() => {
          const existing = observeExternalOperation<T>(input.operation, input.key, inputDigest);
          if (existing.kind !== 'absent') return existing;
          const now = timestamp();
          if (deadlineAt <= now) throw new RangeError('External operation deadline must be in the future');
          const lastFence = db.prepare(`
            SELECT COALESCE(MAX(fencing_epoch), 0) AS fencing_epoch
            FROM research_external_operations WHERE workspace_key = ?
          `).get(workspaceKey) as { fencing_epoch: number };
          const claim = { ownerId: input.ownerId, fencingToken: lastFence.fencing_epoch + 1 };
          db.prepare(`
            INSERT INTO research_external_operations(
              workspace_key, operation, idempotency_key, input_digest, status, result_json,
              owner_id, fencing_epoch, started_at_utc, deadline_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?, ?)
          `).run(workspaceKey, input.operation, input.key, inputDigest, claim.ownerId,
            claim.fencingToken, now, deadlineAt, now);
          return { kind: 'claimed', claim, deadlineAt };
        });
      },
      observe<T>(operation, key, validatedInput): ExternalOperationObservation<T> {
        requireText(key, 'idempotency key', 200);
        const inputDigest = hashText(canonicalJson(validatedInput));
        return withTransaction(() => observeExternalOperation<T>(operation, key, inputDigest));
      },
      complete<T>(input): { kind: 'completed'; value: T } | { kind: 'unknown' } {
        requireText(input.key, 'idempotency key', 200);
        const inputDigest = hashText(canonicalJson(input.validatedInput));
        return withTransaction(() => {
          const existing = observeExternalOperation<T>(input.operation, input.key, inputDigest);
          if (existing.kind === 'replay') return { kind: 'completed', value: existing.value };
          if (existing.kind === 'unknown') return { kind: 'unknown' };
          if (existing.kind !== 'pending' || existing.ownerId !== input.claim.ownerId ||
              existing.fencingToken !== input.claim.fencingToken) {
            throw new Error('External operation fencing claim is no longer current');
          }
          if (existing.deadlineAt <= timestamp()) {
            db.prepare(`
              UPDATE research_external_operations SET status = 'unknown', updated_at_utc = ?
              WHERE workspace_key = ? AND operation = ? AND idempotency_key = ?
                AND owner_id = ? AND fencing_epoch = ? AND status = 'pending'
            `).run(timestamp(), workspaceKey, input.operation, input.key,
              input.claim.ownerId, input.claim.fencingToken);
            return { kind: 'unknown' };
          }

          const value = invokeSynchronous(input.effect, 'External operation persistence callbacks');
          const resultJson = canonicalJson(value);
          const now = timestamp();
          const usageJson = input.usage === undefined ? null : canonicalJson(input.usage);
          const changed = db.prepare(`
            UPDATE research_external_operations SET status = 'completed', result_json = ?, usage_json = ?, updated_at_utc = ?
            WHERE workspace_key = ? AND operation = ? AND idempotency_key = ?
              AND input_digest = ? AND owner_id = ? AND fencing_epoch = ?
              AND status = 'pending' AND deadline_at_utc > ?
          `).run(resultJson, usageJson, now, workspaceKey, input.operation, input.key, inputDigest,
            input.claim.ownerId, input.claim.fencingToken, now);
          if (changed.changes !== 1) throw new Error('External operation fencing claim expired before persistence');
          db.prepare(`
            INSERT INTO research_idempotency_receipts(
              workspace_key, operation, idempotency_key, input_digest, result_json, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(workspaceKey, input.operation, input.key, inputDigest, resultJson, now);
          return { kind: 'completed', value: parseJson<T>(resultJson) };
        });
      },
      markUnknown(input): void {
        requireText(input.key, 'idempotency key', 200);
        const inputDigest = hashText(canonicalJson(input.validatedInput));
        withTransaction(() => {
          const existing = observeExternalOperation(input.operation, input.key, inputDigest);
          if (existing.kind === 'unknown' || existing.kind === 'absent' || existing.kind === 'replay') return;
          if (existing.kind !== 'pending' || existing.ownerId !== input.claim.ownerId ||
              existing.fencingToken !== input.claim.fencingToken) {
            throw new Error('External operation fencing claim is no longer current');
          }
          const usageJson = input.usage === undefined ? null : canonicalJson(input.usage);
          db.prepare(`
            UPDATE research_external_operations SET status = 'unknown', usage_json = COALESCE(?, usage_json), updated_at_utc = ?
            WHERE workspace_key = ? AND operation = ? AND idempotency_key = ?
              AND input_digest = ? AND owner_id = ? AND fencing_epoch = ? AND status = 'pending'
          `).run(usageJson, timestamp(), workspaceKey, input.operation, input.key, inputDigest,
            input.claim.ownerId, input.claim.fencingToken);
        });
      },
    },

    idempotency: {
      execute<T>(operation, key, validatedInput, effect): { replayed: boolean; value: T } {
        requireText(key, 'idempotency key', 200);
        const inputDigest = hashText(canonicalJson(validatedInput));
        const outcome = withTransaction(() => {
          const existing = db.prepare(`
            SELECT input_digest, result_json FROM research_idempotency_receipts
            WHERE workspace_key = ? AND operation = ? AND idempotency_key = ?
          `).get(workspaceKey, operation, key) as { input_digest: string; result_json: string } | undefined;
          if (existing) {
            if (existing.input_digest !== inputDigest) throw new IdempotencyConflictError(operation);
            return { state: 'value' as const, result: { replayed: true, value: parseJson<T>(existing.result_json) } };
          }
          if (operation === 'research_plan') {
            const external = observeExternalOperation<T>(operation, key, inputDigest);
            if (external.kind === 'replay') {
              return { state: 'value' as const, result: { replayed: true, value: external.value } };
            }
            // Return these states so an expiry transition commits before the
            // typed repository error is raised outside the transaction.
            if (external.kind === 'pending') return { state: 'pending' as const };
            if (external.kind === 'unknown') return { state: 'unknown' as const };
          }
          const value = invokeSynchronous(effect, 'Idempotency effects');
          const resultJson = canonicalJson(value);
          db.prepare(`
            INSERT INTO research_idempotency_receipts(
              workspace_key, operation, idempotency_key, input_digest, result_json, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(workspaceKey, operation, key, inputDigest, resultJson, timestamp());
          return { state: 'value' as const, result: { replayed: false, value: parseJson<T>(resultJson) } };
        });
        if (outcome.state === 'pending') throw new ExternalOperationPendingError(operation);
        if (outcome.state === 'unknown') throw new ExternalOperationOutcomeUnknownError(operation);
        return outcome.result;
      },
    },

    leases: {
      acquire(request): WorkspaceRunLease {
        validateLeaseTtl(request.ttlMilliseconds);
        requireText(request.ownerInstanceId, 'ownerInstanceId', 200);
        return withTransaction(() => acquireLeaseInTransaction(request));
      },
      acquireWithRecovery(request): { lease: WorkspaceRunLease; recoveredRunId: string | null } {
        validateLeaseTtl(request.ttlMilliseconds);
        requireText(request.ownerInstanceId, 'ownerInstanceId', 200);
        return withTransaction(() => {
          const recoveredRunId = recoverExpiredLeaseInTransaction();
          const lease = acquireLeaseInTransaction(request);
          return { lease, recoveredRunId };
        });
      },
      recoverExpired(): string | null {
        return withTransaction(() => recoverExpiredLeaseInTransaction());
      },
      renew(lease, ttlMilliseconds): WorkspaceRunLease {
        validateLeaseTtl(ttlMilliseconds);
        return withTransaction(() => {
          assertLeaseCurrent(lease);
          const now = timestamp();
          const expiresAt = new Date(Date.parse(now) + ttlMilliseconds).toISOString();
          const updated = db.prepare(`
            UPDATE research_workspace_leases SET expires_at_utc = ?, renewed_at_utc = ?
            WHERE workspace_key = ? AND run_id = ? AND owner_instance_id = ? AND fencing_epoch = ? AND expires_at_utc > ?
          `).run(expiresAt, now, workspaceKey, lease.runId, lease.ownerInstanceId, lease.fencingToken, now);
          if (updated.changes !== 1) throw new StaleWorkspaceLeaseError();
          return { ...lease, expiresAt, renewedAt: now };
        });
      },
      release(lease): boolean {
        return withTransaction(() => {
          if (lease.workspaceKey !== workspaceKey) return false;
          const now = timestamp();
          const updated = db.prepare(`
            UPDATE research_workspace_leases
            SET owner_instance_id = NULL, run_id = NULL, expires_at_utc = NULL, renewed_at_utc = NULL
            WHERE workspace_key = ? AND run_id = ? AND owner_instance_id = ? AND fencing_epoch = ? AND expires_at_utc > ?
          `).run(workspaceKey, lease.runId, lease.ownerInstanceId, lease.fencingToken, now);
          return updated.changes === 1;
        });
      },
      assertCurrent(lease): void {
        assertLeaseCurrent(lease);
      },
      withWrite<T>(lease: WorkspaceRunLease, effect: () => T): T {
        return withTransaction<T>(() => {
          assertLeaseCurrent(lease);
          const result = invokeSynchronous(effect, 'Lease write callbacks');
          // Expiry during a multi-statement callback invalidates the transaction.
          assertLeaseCurrent(lease);
          return result;
        });
      },
    },
  };

  function insertAssessmentEvidenceRef(
    runId: string,
    _caseId: string,
    hypothesisId: string,
    evidenceId: string,
    relationship: 'supports' | 'contradicts',
  ): void {
    const evidence = db.prepare(`
      SELECT evidence_kind, hypothesis_id, relationship, payload_json FROM research_evidence
      WHERE workspace_key = ? AND run_id = ? AND evidence_id = ?
    `).get(workspaceKey, runId, evidenceId) as { evidence_kind: string; hypothesis_id: string | null; relationship: string | null; payload_json: string } | undefined;
    if (!evidence || evidence.evidence_kind !== 'verified_excerpt' || evidence.hypothesis_id !== hypothesisId) {
      throw new RepositoryNotFoundError('verified evidence for hypothesis', evidenceId);
    }
    const verified = parseJson<VerifiedEvidenceLink>(evidence.payload_json);
    if (evidence.relationship !== relationship || verified.relationship !== relationship) {
      throw new TypeError('Assessment evidence relationship does not match its verified link');
    }
    db.prepare(`
      INSERT INTO research_assessment_evidence_refs(workspace_key, run_id, hypothesis_id, evidence_id, evidence_kind, relationship)
      VALUES (?, ?, ?, ?, 'verified_excerpt', ?)
    `).run(workspaceKey, runId, hypothesisId, evidenceId, relationship);
  }

  return repositories;
}
