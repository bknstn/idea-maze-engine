/** Synthetic in-process protocol fixture. Never uses a real workspace/provider. */

import {
  type ResearchApplication,
  type ResearchCapabilities,
  type ResearchCase,
  type ResearchResultPage,
  type RunStatusResult,
  success,
} from "../../research/contracts.js";

export interface FakeResearchApplicationOptions {
  workDelayMilliseconds?: number;
  oversizedResult?: boolean;
  throwOnCapabilities?: boolean;
  hangOnCapabilities?: boolean;
  malformedCapabilities?: boolean;
  malformedFailureDetails?: boolean;
}

export interface FakeResearchApplication {
  app: ResearchApplication;
  calls: Record<string, number>;
  latestRunId: string | null;
  setNextStartReceiptDelay(milliseconds: number): void;
  shutdown(): void;
}

const NOW = "2026-10-28T12:00:00.000Z";

function fixtureCase(): ResearchCase {
  return {
    caseId: "fake-case-1",
    revision: 1,
    status: "ready",
    intake: {
      ideaSummary: "A synthetic service helps teams compare product assumptions.",
      targetUser: "Small product teams",
      problem: "Teams need a repeatable way to compare assumptions.",
      proposedSolution: "A synthetic research workflow",
    },
    hypotheses: [{
      hypothesisId: "fake-hypothesis-1",
      revision: 1,
      claim: "Small product teams want a repeatable way to compare assumptions.",
      origin: "user_supplied",
      sourceSuggestionId: null,
      state: "active",
      createdAt: NOW,
    }],
    missingFields: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixtureCapabilities(): ResearchCapabilities {
  return {
    capabilities: {
      model: { availability: "not_configured", adapter: null },
      search: { availability: "not_configured", adapter: null },
      original_source_fetch: { availability: "not_configured", adapter: null },
    },
    limits: {
      maxQueries: 8,
      maxFetchedPages: 12,
      maxFollowUpRounds: 1,
      maxWallTimeSeconds: 60,
      maxModelInputTokens: 1000,
      maxModelOutputTokens: 1000,
    },
    storageMode: "single_owner_workspace",
  };
}

function fixtureStatus(runId: string, status: RunStatusResult["status"]): RunStatusResult {
  return {
    runId,
    caseId: "fake-case-1",
    caseRevision: 1,
    planId: "fake-plan-1",
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
    createdAt: NOW,
    startedAt: status === "queued" ? null : NOW,
    finishedAt: status === "completed" ? NOW : null,
    cancelRequestedAt: null,
  };
}

function resultPage(oversized: boolean): ResearchResultPage {
  return {
    runId: "fake-run-1",
    assessment: null,
    evidence: [],
    coverageGaps: oversized
      ? Array.from({ length: 700 }, (_, index) => ({
          reason: "no_results" as const,
          detail: `Synthetic bounded-output fixture ${index}: ${"x".repeat(950)}`,
          queryId: null,
          hypothesisId: null,
        }))
      : [],
    pagination: { nextCursor: null, hasMore: false, totalEvidence: 0 },
    reportMarkdown: null,
  };
}

export function createFakeResearchApplication(
  options: FakeResearchApplicationOptions = {},
): FakeResearchApplication {
  const calls: Record<string, number> = Object.create(null) as Record<string, number>;
  let latestRunId: string | null = null;
  let currentStatus: RunStatusResult | null = null;
  let nextStartReceiptDelay = 0;
  let workTimer: ReturnType<typeof setTimeout> | undefined;

  const called = (name: string) => { calls[name] = (calls[name] ?? 0) + 1; };
  const app: ResearchApplication = {
    async capabilities() {
      called("capabilities");
      if (options.hangOnCapabilities) await new Promise<void>(() => undefined);
      if (options.throwOnCapabilities) throw new Error("synthetic_private_token_should_not_escape");
      if (options.malformedCapabilities) return null as never;
      if (options.malformedFailureDetails) {
        return {
          schemaVersion: "1.0.0",
          error: {
            code: "INTERNAL_ERROR",
            message: "The research request could not be completed.",
            retryable: false,
            details: { kind: "internal", secretSentinel: "synthetic_raw_error_detail_should_not_escape" },
          },
        } as never;
      }
      return success(fixtureCapabilities());
    },
    async createCase() {
      called("createCase");
      return success({ case: fixtureCase() });
    },
    async getCase() {
      called("getCase");
      return success(fixtureCase());
    },
    async updateCase(input) {
      called("updateCase");
      const value = fixtureCase();
      value.revision = input.expectedRevision + 1;
      value.updatedAt = NOW;
      return success({ case: value });
    },
    async plan(input) {
      called("plan");
      return success({
        status: "needs_clarification",
        caseId: input.caseId,
        caseRevision: input.expectedCaseRevision,
        plan: null,
        missingFields: [],
        hypothesisSuggestions: [],
      });
    },
    async start(input) {
      called("start");
      const runId = `fake-run-${(calls.start ?? 1)}`;
      latestRunId = runId;
      currentStatus = fixtureStatus(runId, "running");
      if (workTimer) clearTimeout(workTimer);
      workTimer = setTimeout(() => {
        if (currentStatus?.runId === runId) currentStatus = fixtureStatus(runId, "completed");
      }, options.workDelayMilliseconds ?? 300);
      const receiptDelay = nextStartReceiptDelay;
      nextStartReceiptDelay = 0;
      if (receiptDelay > 0) await new Promise((resolve) => setTimeout(resolve, receiptDelay));
      return success({
        runId,
        status: "queued",
        caseId: input.caseId,
        caseRevision: input.expectedCaseRevision,
        planId: input.planId,
        acceptedAt: NOW,
      });
    },
    async status(input) {
      called("status");
      if (!currentStatus || currentStatus.runId !== input.runId) {
        return success(fixtureStatus(input.runId, "queued"));
      }
      return success({ ...currentStatus });
    },
    async result(input) {
      called("result");
      return success({ ...resultPage(options.oversizedResult ?? false), runId: input.runId });
    },
    async cancel(input) {
      called("cancel");
      if (currentStatus?.runId === input.runId && ["queued", "running", "cancellation_requested"].includes(currentStatus.status)) {
        currentStatus = { ...currentStatus, status: "cancellation_requested", cancelRequestedAt: NOW };
      }
      return success({
        runId: input.runId,
        status: currentStatus?.runId === input.runId ? currentStatus.status : "completed",
        cancellationRequested: currentStatus?.status === "cancellation_requested",
        cancelRequestedAt: currentStatus?.runId === input.runId ? currentStatus.cancelRequestedAt : null,
      });
    },
  };

  return {
    app,
    calls,
    get latestRunId() { return latestRunId; },
    setNextStartReceiptDelay(milliseconds) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 5000) {
        throw new RangeError("fake delay must be an integer from 0 through 5000");
      }
      nextStartReceiptDelay = milliseconds;
    },
    shutdown() {
      if (workTimer) clearTimeout(workTimer);
      if (currentStatus && ["queued", "running", "cancellation_requested"].includes(currentStatus.status)) {
        currentStatus = { ...currentStatus, status: "interrupted", stoppingReason: "service_shutdown", finishedAt: NOW } as RunStatusResult;
      }
    },
  };
}
