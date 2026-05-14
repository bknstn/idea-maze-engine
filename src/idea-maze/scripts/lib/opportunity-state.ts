import type Database from "better-sqlite3";

import { recordRunEvent } from "./run-events.ts";

export const OPPORTUNITY_LIFECYCLE_STAGES = [
  "scored",
  "shortlisted",
  "researching",
  "artifact",
  "review_gate",
  "approved",
  "rejected",
  "archived",
] as const;

export type OpportunityLifecycleStage = (typeof OPPORTUNITY_LIFECYCLE_STAGES)[number];

export interface OpportunityScoreSet {
  finalScore: number;
  marketScore: number;
  tasteAdjustment: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return round2(Math.max(0, Math.min(10, value)));
}

export function mergeOpportunityMetadata(
  raw: string,
  patch: Record<string, unknown>,
): string {
  let current: Record<string, unknown>;
  try {
    current = JSON.parse(raw);
  } catch {
    current = {};
  }
  return JSON.stringify({
    ...current,
    ...patch,
  });
}

export function updateOpportunityScores(
  db: Database.Database,
  opportunityId: number,
  scores: OpportunityScoreSet,
): void {
  const now = new Date().toISOString();
  const finalScore = clampScore(scores.finalScore);
  const marketScore = clampScore(scores.marketScore);
  const tasteAdjustment = round2(
    Math.max(-1.5, Math.min(1.5, Number.isFinite(scores.tasteAdjustment) ? scores.tasteAdjustment : 0)),
  );

  db.prepare(`
    UPDATE opportunities
    SET market_score = ?,
        taste_adjustment = ?,
        final_score = ?,
        score = ?,
        updated_at_utc = ?
    WHERE id = ?
  `).run(marketScore, tasteAdjustment, finalScore, finalScore, now, opportunityId);
}

export function setOpportunityLifecycle(
  db: Database.Database,
  opportunityId: number,
  lifecycleStage: OpportunityLifecycleStage,
  options: {
    actor?: string;
    payload?: Record<string, unknown>;
    runId?: number | null;
    status?: "active" | "archived";
    summary?: string;
  } = {},
): void {
  const now = new Date().toISOString();
  const opportunity = db.prepare(`
    SELECT lifecycle_stage, status, metadata_json
    FROM opportunities
    WHERE id = ?
  `).get(opportunityId) as
    | { lifecycle_stage: OpportunityLifecycleStage | null; metadata_json: string; status: string }
    | undefined;

  if (!opportunity) {
    throw new Error(`Opportunity #${opportunityId} not found.`);
  }

  const nextStatus = options.status ?? opportunity.status;
  const metadataPatch =
    lifecycleStage === "archived" && options.payload?.archive_reason
      ? { archive_reason: options.payload.archive_reason }
      : {};

  db.prepare(`
    UPDATE opportunities
    SET lifecycle_stage = ?,
        status = ?,
        metadata_json = ?,
        updated_at_utc = ?
    WHERE id = ?
  `).run(
    lifecycleStage,
    nextStatus,
    mergeOpportunityMetadata(opportunity.metadata_json, metadataPatch),
    now,
    opportunityId,
  );

  if (opportunity.lifecycle_stage !== lifecycleStage || opportunity.status !== nextStatus) {
    recordRunEvent(db, {
      actor: options.actor ?? "system",
      eventType: "lifecycle.transition",
      opportunityId,
      payload: {
        from: opportunity.lifecycle_stage,
        payload: options.payload ?? {},
        status_from: opportunity.status,
        status_to: nextStatus,
        to: lifecycleStage,
      },
      runId: options.runId ?? null,
      stage: "lifecycle",
      status: "info",
      summary: options.summary ?? `Opportunity moved to ${lifecycleStage}`,
    });
  }
}
