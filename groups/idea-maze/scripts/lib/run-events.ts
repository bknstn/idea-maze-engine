import type Database from "better-sqlite3";

export const PARENT_RUN_ID_ENV = "IDEA_MAZE_PARENT_RUN_ID";

export type RunEventStatus = "info" | "ok" | "warning" | "error";

export interface RunEventInput {
  actor?: string;
  createdAtUtc?: string;
  eventType: string;
  opportunityId?: number | null;
  payload?: unknown;
  runId?: number | null;
  stage?: string | null;
  status?: RunEventStatus;
  summary: string;
}

export interface StageRunContext {
  emit: (event: Omit<RunEventInput, "runId" | "stage"> & { stage?: string | null }) => void;
  finish: (status: "completed" | "error", summary: string, payload?: unknown) => void;
  runId: number;
  stage: string;
}

interface CreateRunInput {
  metadata?: Record<string, unknown>;
  requestedBy?: string;
  runType: string;
  status?: string;
  targetId?: string | null;
  targetType?: string | null;
}

function stringifyPayload(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function createRun(db: Database.Database, input: CreateRunInput): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runType,
    input.targetType ?? null,
    input.targetId ?? null,
    input.status ?? "running",
    input.requestedBy ?? "system",
    now,
    JSON.stringify(input.metadata ?? {}),
  );
  return Number(result.lastInsertRowid);
}

export function updateRunStatus(
  db: Database.Database,
  runId: number,
  status: string,
  options: { error?: string | null; metadata?: Record<string, unknown> | null } = {},
): void {
  const now = new Date().toISOString();
  if (options.metadata) {
    db.prepare(`
      UPDATE runs
      SET status = ?, completed_at_utc = ?, error = ?, metadata_json = ?
      WHERE id = ?
    `).run(status, now, options.error ?? null, JSON.stringify(options.metadata), runId);
    return;
  }

  db.prepare(`
    UPDATE runs
    SET status = ?, completed_at_utc = ?, error = COALESCE(?, error)
    WHERE id = ?
  `).run(status, now, options.error ?? null, runId);
}

export function getParentRunIdFromEnv(): number | null {
  const raw = process.env[PARENT_RUN_ID_ENV];
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function recordRunEvent(db: Database.Database, input: RunEventInput): void {
  if (!Number.isFinite(Number(input.runId))) {
    return;
  }

  db.prepare(`
    INSERT INTO run_events (
      run_id,
      opportunity_id,
      event_type,
      stage,
      actor,
      status,
      summary,
      payload_json,
      created_at_utc
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(input.runId),
    input.opportunityId ?? null,
    input.eventType,
    input.stage ?? null,
    input.actor ?? "system",
    input.status ?? "info",
    input.summary,
    stringifyPayload(input.payload),
    input.createdAtUtc ?? new Date().toISOString(),
  );
}

export function withStageRunContext(
  db: Database.Database,
  stage: string,
  options: { requestedBy?: string } = {},
): StageRunContext {
  const parentRunId = getParentRunIdFromEnv();
  const runId = parentRunId ?? createRun(db, {
    requestedBy: options.requestedBy ?? "system",
    runType: stage,
    status: "running",
    targetId: stage,
    targetType: "pipeline_stage",
  });
  const ownsRun = parentRunId === null;

  recordRunEvent(db, {
    eventType: "stage.started",
    runId,
    stage,
    status: "info",
    summary: `${stage} started`,
  });

  return {
    emit(event) {
      recordRunEvent(db, {
        ...event,
        runId,
        stage: event.stage ?? stage,
      });
    },
    finish(status, summary, payload) {
      recordRunEvent(db, {
        eventType: status === "completed" ? "stage.completed" : "stage.failed",
        payload,
        runId,
        stage,
        status: status === "completed" ? "ok" : "error",
        summary,
      });
      if (ownsRun) {
        updateRunStatus(db, runId, status, {
          error: status === "error" ? summary : null,
        });
      }
    },
    runId,
    stage,
  };
}

export function classifyFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes("timed out")) return "timeout";
  if (lowered.includes("retry")) return "retry_exhausted";
  if (lowered.includes("validation")) return "validation";
  if (lowered.includes("api")) return "api";
  if (lowered.includes("json")) return "invalid_json";
  return "unknown";
}
