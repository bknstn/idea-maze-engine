import { hashSourceText } from "../scripts/lib/evidence-excerpts.js";
import {
  RESEARCH_SCHEMA_VERSION,
  success,
  type ResearchAssessment,
  type ResearchCase,
  type ResearchCaseRevision,
  type ResearchPlanSnapshot,
  type ResearchResponse,
  type ResearchRunStep,
  type ResearchUsage,
  type ToolDataMap,
  type ToolInputMap,
} from "./contracts.js";
import type { ResearchToolName } from "./tools.js";

/** Every idea, claim, URL, source quote, ID, and timestamp below is synthetic. */
export type SyntheticToolCall = {
  [TName in ResearchToolName]: {
    toolName: TName;
    input: ToolInputMap[TName];
    response: ResearchResponse<ToolDataMap[TName]>;
  }
}[ResearchToolName];

export interface SyntheticResearchExample {
  explanation: string;
  calls: SyntheticToolCall[];
}

const AT = "2026-01-02T03:04:05.000Z";
const CASE_ID = "case_example_kitchen";
const HYPOTHESIS_ID = "hypothesis_example_stockouts";
const PLAN_ID = "plan_example_balanced";
const RUN_ID = "run_example_completed";
const SUPPORT_QUERY_ID = "query_example_support";
const CHALLENGE_QUERY_ID = "query_example_challenge";

const initialDraft: ResearchCase = {
  caseId: CASE_ID,
  revision: 1,
  status: "draft",
  intake: {
    ideaSummary: "A lightweight inventory reminder for small kitchens.",
    problem: "Small kitchens can run out of commonly used ingredients before a restock.",
  },
  hypotheses: [],
  missingFields: [
    { field: "targetUser", blockingForPlanning: true, clarification: "Who is the intended user or buyer?" },
    { field: "proposedSolution", blockingForPlanning: true, clarification: "What solution are you proposing?" },
    { field: "currentAlternatives", blockingForPlanning: false, clarification: "What do people use or do today instead?" },
    { field: "usageFrequency", blockingForPlanning: false, clarification: "How often does the problem or job occur?" },
    { field: "budgetOrWillingnessToPay", blockingForPlanning: false, clarification: "What budget or willingness to pay is known?" },
    { field: "decisionMaker", blockingForPlanning: false, clarification: "Who decides whether to adopt or pay?" },
    { field: "constraints", blockingForPlanning: false, clarification: "What technical, legal, or operational constraints are known?" },
    { field: "hypotheses", blockingForPlanning: true, clarification: "Add at least one testable hypothesis or request labeled suggestions." },
  ],
  createdAt: AT,
  updatedAt: AT,
};

const readyCase: ResearchCase = {
  caseId: CASE_ID,
  revision: 2,
  status: "ready",
  intake: {
    ...initialDraft.intake,
    targetUser: "Owners of small independent kitchens",
    proposedSolution: "A simple shared checklist with reminders before common ingredients run out.",
    currentAlternatives: [],
    usageFrequency: "Stock is reviewed several times each week.",
    budgetOrWillingnessToPay: null,
    decisionMaker: "The kitchen owner or manager",
    constraints: [],
  },
  hypotheses: [{
    hypothesisId: HYPOTHESIS_ID,
    revision: 1,
    claim: "Small kitchen teams lose preparation time when common ingredients run out unexpectedly.",
    origin: "user_supplied",
    sourceSuggestionId: null,
    state: "active",
    createdAt: AT,
  }],
  missingFields: [
    { field: "budgetOrWillingnessToPay", blockingForPlanning: false, clarification: "What budget or willingness to pay is known?" },
  ],
  createdAt: AT,
  updatedAt: "2026-01-02T03:09:05.000Z",
};

const caseRevisionOne: ResearchCase = { ...initialDraft };

const caseRevisionSnapshot: ResearchCaseRevision = {
  caseId: CASE_ID,
  revision: 2,
  intake: readyCase.intake,
  hypothesisRevisions: readyCase.hypotheses,
  createdAt: readyCase.updatedAt,
};

const plan: ResearchPlanSnapshot = {
  planId: PLAN_ID,
  caseId: CASE_ID,
  caseRevision: 2,
  queries: [
    {
      queryId: SUPPORT_QUERY_ID,
      text: "small kitchen ingredient stockout preparation delays",
      purpose: "problem_language",
      evidenceIntent: "supporting",
      hypothesisIds: [HYPOTHESIS_ID],
      sourceScopes: ["public_web", "community_discussions"],
    },
    {
      queryId: CHALLENGE_QUERY_ID,
      text: "small kitchen inventory checklist adoption objections",
      purpose: "counterevidence",
      evidenceIntent: "challenging",
      hypothesisIds: [HYPOTHESIS_ID],
      sourceScopes: ["public_web", "community_discussions"],
    },
  ],
  limits: {
    maxQueries: 2,
    maxFetchedPages: 5,
    maxFollowUpRounds: 1,
    maxWallTimeSeconds: 120,
    maxModelInputTokens: 3000,
    maxModelOutputTokens: 1000,
  },
  createdAt: "2026-01-02T03:10:00.000Z",
};

export const SYNTHETIC_SOURCE_TEXT = "A weekly stock check helped our kitchen avoid running out of supplies.";
const sampleSourceText = SYNTHETIC_SOURCE_TEXT;
const quoteStart = sampleSourceText.indexOf("weekly stock check");
const quoteEnd = quoteStart + "weekly stock check".length;

const assessment: ResearchAssessment = {
  outcome: "insufficient_evidence",
  summary: "The available material does not establish whether unexpected stockouts are common across small kitchens.",
  rationale: "One fetched original contains contextual wording. A search snippet is only a discovery lead and cannot support the claim. Independent support and counterevidence are still missing.",
  claims: [{
    hypothesisId: HYPOTHESIS_ID,
    outcome: "insufficient_evidence",
    rationale: "The verified excerpt is contextual and does not describe an unexpected stockout or lost preparation time.",
    supportingEvidenceIds: [],
    challengingEvidenceIds: [],
    missingEvidence: ["Independent first-hand accounts of unexpected stockouts", "Evidence about resulting preparation time"],
  }],
  coverageGaps: [{
    reason: "no_independent_sources",
    detail: "Only one original source was verified; no independent source established the claim.",
    queryId: null,
    hypothesisId: HYPOTHESIS_ID,
  }],
  nextExperiment: "Interview several small-kitchen operators about recent stockouts and record frequency and preparation impact.",
};

const evidence = [
  {
    kind: "verified_excerpt" as const,
    evidenceId: "evidence_example_context",
    hypothesisId: HYPOTHESIS_ID,
    relationship: "context" as const,
    source: {
      sourceId: "source_items:42",
      canonicalUrl: "https://example.com/kitchen-stock-check",
      retrievedAt: "2026-01-02T03:11:20.000Z",
    },
    excerpt: {
      version: 1 as const,
      sourceItemId: 42,
      role: "workaround" as const,
      quote: sampleSourceText.slice(quoteStart, quoteEnd),
      sourceTextHash: hashSourceText(sampleSourceText),
      startUtf16: quoteStart,
      endUtf16: quoteEnd,
    },
    verification: "matched_to_fetched_original" as const,
    interpretation: "This mentions a routine stock check but does not establish a stockout or resulting delay.",
    independenceGroupId: "source_items:42",
  },
  {
    kind: "search_snippet" as const,
    snippetId: "snippet_example_lead",
    queryId: SUPPORT_QUERY_ID,
    sourceUrl: "https://example.com/forum-post",
    text: "A short search preview mentions checking supplies before prep.",
    assessmentEligible: false as const,
  },
];

const usage: ResearchUsage = {
  searchRequests: 2,
  fetchedPages: 1,
  modelInputTokens: 900,
  modelOutputTokens: 320,
  providerCostMicros: null,
  elapsedMilliseconds: 18200,
};

const completedSteps: ResearchRunStep[] = [
  { name: "search", status: "succeeded", startedAt: "2026-01-02T03:10:10.000Z", finishedAt: "2026-01-02T03:10:17.000Z", failureCode: null, providerAvailability: "available" },
  { name: "fetch_originals", status: "succeeded", startedAt: "2026-01-02T03:10:17.000Z", finishedAt: "2026-01-02T03:10:21.000Z", failureCode: null, providerAvailability: "available" },
  { name: "map_evidence", status: "succeeded", startedAt: "2026-01-02T03:10:21.000Z", finishedAt: "2026-01-02T03:10:24.000Z", failureCode: null, providerAvailability: null },
  { name: "assess", status: "succeeded", startedAt: "2026-01-02T03:10:24.000Z", finishedAt: "2026-01-02T03:10:28.000Z", failureCode: null, providerAvailability: "available" },
];

function successfulCall<TName extends ResearchToolName>(
  toolName: TName,
  input: ToolInputMap[TName],
  data: ToolDataMap[TName],
): SyntheticToolCall {
  return { toolName, input, response: success(data) } as SyntheticToolCall;
}

export function buildSyntheticResearchExample(): SyntheticResearchExample {
  return {
    explanation: "A draft is clarified, a balanced caller-supplied plan is saved, the run completes with insufficient evidence, a result is paginated, and cancellation is shown as a separate run-control path.",
    calls: [
      successfulCall("research_capabilities", {}, {
        capabilities: {
          model: { availability: "available", adapter: "configured_model" },
          search: { availability: "available", adapter: "configured_search" },
          original_source_fetch: { availability: "available", adapter: "public_source_reader" },
        },
        limits: plan.limits,
        storageMode: "single_owner_workspace",
      }),
      successfulCall("research_case_create", {
        idempotencyKey: "example-case-create-0001",
        intake: {
          ideaSummary: initialDraft.intake.ideaSummary,
          problem: initialDraft.intake.problem,
        },
      }, { case: initialDraft }),
      successfulCall("research_plan", {
        idempotencyKey: "example-plan-incomplete-0001",
        caseId: CASE_ID,
        expectedCaseRevision: 1,
      }, {
        status: "needs_clarification",
        caseId: CASE_ID,
        caseRevision: 1,
        plan: null,
        missingFields: initialDraft.missingFields.filter((field) => field.blockingForPlanning),
        hypothesisSuggestions: [],
      }),
      successfulCall("research_case_update", {
        idempotencyKey: "example-case-update-0001",
        caseId: CASE_ID,
        expectedRevision: 1,
        intakePatch: {
          targetUser: "Owners of small independent kitchens",
          proposedSolution: "A simple shared checklist with reminders before common ingredients run out.",
          currentAlternatives: [],
          usageFrequency: "Stock is reviewed several times each week.",
          budgetOrWillingnessToPay: null,
          decisionMaker: "The kitchen owner or manager",
          constraints: [],
        },
        hypothesisMutations: [{
          operation: "add",
          clientRef: "stockouts",
          claim: "Small kitchen teams lose preparation time when common ingredients run out unexpectedly.",
        }],
      }, { case: readyCase }),
      successfulCall("research_case_get", { caseId: CASE_ID, revision: 1 }, caseRevisionOne),
      successfulCall("research_plan", {
        idempotencyKey: "example-plan-balanced-0001",
        caseId: CASE_ID,
        expectedCaseRevision: 2,
        suppliedPlan: {
          queries: plan.queries.map(({ queryId: _queryId, ...query }) => query),
          limits: plan.limits,
        },
      }, {
        status: "ready",
        caseId: CASE_ID,
        caseRevision: 2,
        plan,
        missingFields: readyCase.missingFields,
        hypothesisSuggestions: [],
      }),
      successfulCall("research_start", {
        idempotencyKey: "example-start-run-0001",
        caseId: CASE_ID,
        expectedCaseRevision: 2,
        planId: PLAN_ID,
      }, {
        runId: RUN_ID,
        status: "queued",
        caseId: CASE_ID,
        caseRevision: 2,
        planId: PLAN_ID,
        acceptedAt: "2026-01-02T03:10:05.000Z",
      }),
      successfulCall("research_status", { runId: RUN_ID }, {
        runId: RUN_ID,
        caseId: CASE_ID,
        caseRevision: 2,
        planId: PLAN_ID,
        status: "completed",
        steps: completedSteps,
        usage,
        coverageGaps: assessment.coverageGaps,
        stoppingReason: "all_steps_finished",
        createdAt: "2026-01-02T03:10:05.000Z",
        startedAt: "2026-01-02T03:10:06.000Z",
        finishedAt: "2026-01-02T03:10:28.000Z",
        cancelRequestedAt: null,
      }),
      successfulCall("research_result", { runId: RUN_ID, limit: 1, format: "json" }, {
        runId: RUN_ID,
        assessment,
        evidence: [evidence[0]],
        coverageGaps: assessment.coverageGaps,
        pagination: { nextCursor: "cursor_example_page_2", hasMore: true, totalEvidence: 2 },
        reportMarkdown: null,
      }),
      successfulCall("research_result", { runId: RUN_ID, cursor: "cursor_example_page_2", limit: 1, format: "markdown" }, {
        runId: RUN_ID,
        assessment,
        evidence: [evidence[1]],
        coverageGaps: assessment.coverageGaps,
        pagination: { nextCursor: null, hasMore: false, totalEvidence: 2 },
        reportMarkdown: "# Research result\n\nThe search snippet is a discovery lead only and does not support the hypothesis.",
      }),
      successfulCall("research_cancel", { runId: RUN_ID, idempotencyKey: "example-cancel-terminal-0001" }, {
        runId: RUN_ID,
        status: "completed",
        cancellationRequested: false,
        cancelRequestedAt: null,
      }),
      successfulCall("research_start", {
        idempotencyKey: "example-start-cancel-0001",
        caseId: CASE_ID,
        expectedCaseRevision: 2,
        planId: PLAN_ID,
      }, {
        runId: "run_example_cancel_path",
        status: "queued",
        caseId: CASE_ID,
        caseRevision: 2,
        planId: PLAN_ID,
        acceptedAt: "2026-01-02T03:12:00.000Z",
      }),
      successfulCall("research_cancel", { runId: "run_example_cancel_path", idempotencyKey: "example-cancel-active-0001" }, {
        runId: "run_example_cancel_path",
        status: "cancellation_requested",
        cancellationRequested: true,
        cancelRequestedAt: "2026-01-02T03:12:03.000Z",
      }),
    ],
  };
}

export function exampleHasSchemaVersion(response: ResearchResponse<unknown>): boolean {
  return response.schemaVersion === RESEARCH_SCHEMA_VERSION;
}
