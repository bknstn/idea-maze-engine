/**
 * Shared domain, application, and protocol contracts for hypothesis research.
 * These types describe planned behavior; they do not imply that a service,
 * repository, provider adapter, or MCP transport has been implemented.
 */

export const RESEARCH_SCHEMA_VERSION = "1.0.0" as const;

export type IntakeField =
  | "ideaSummary"
  | "targetUser"
  | "problem"
  | "proposedSolution"
  | "currentAlternatives"
  | "usageFrequency"
  | "budgetOrWillingnessToPay"
  | "decisionMaker"
  | "constraints"
  | "hypotheses";

/** Missing or null values mean unknown; empty arrays mean explicitly none known. */
export interface ResearchIntake {
  ideaSummary?: string | null;
  targetUser?: string | null;
  problem?: string | null;
  proposedSolution?: string | null;
  currentAlternatives?: string[] | null;
  usageFrequency?: string | null;
  budgetOrWillingnessToPay?: string | null;
  decisionMaker?: string | null;
  constraints?: string[] | null;
}

export type HypothesisOrigin = "user_supplied" | "model_suggested";
export type HypothesisState = "active" | "retired";

export interface HypothesisRevision {
  hypothesisId: string;
  revision: number;
  claim: string;
  origin: HypothesisOrigin;
  /** Null for caller-supplied claims; retained when an accepted suggestion is revised. */
  sourceSuggestionId: string | null;
  state: HypothesisState;
  createdAt: string;
}

export interface ResearchCaseRevision {
  caseId: string;
  revision: number;
  intake: ResearchIntake;
  hypothesisRevisions: HypothesisRevision[];
  createdAt: string;
}

export interface MissingIntakeField {
  field: IntakeField;
  blockingForPlanning: boolean;
  clarification: string;
}

export interface ResearchCase {
  caseId: string;
  revision: number;
  status: "draft" | "ready";
  intake: ResearchIntake;
  hypotheses: HypothesisRevision[];
  missingFields: MissingIntakeField[];
  createdAt: string;
  updatedAt: string;
}

export type QueryPurpose = "problem_language" | "workaround" | "alternative" | "counterevidence";
export type EvidenceIntent = "supporting" | "challenging" | "context";
export type ResearchSourceScope = "public_web" | "public_reddit" | "community_discussions";

export interface ResearchQuery {
  queryId: string;
  text: string;
  purpose: QueryPurpose;
  evidenceIntent: EvidenceIntent;
  hypothesisIds: string[];
  sourceScopes: ResearchSourceScope[];
}

export interface ResearchLimits {
  maxQueries: number;
  maxFetchedPages: number;
  maxFollowUpRounds: number;
  maxWallTimeSeconds: number;
  maxModelInputTokens: number;
  maxModelOutputTokens: number;
}

export interface ResearchPlanSnapshot {
  planId: string;
  caseId: string;
  caseRevision: number;
  queries: ResearchQuery[];
  limits: ResearchLimits;
  createdAt: string;
}

export interface ResearchPlanDraft {
  queries: Array<Omit<ResearchQuery, "queryId">>;
  limits: ResearchLimits;
}

export interface HypothesisSuggestion {
  suggestionId: string;
  claim: string;
  origin: "model_suggested";
  status: "unaccepted_suggestion";
}

export type RunExecutionStatus =
  | "queued"
  | "running"
  | "cancellation_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type RunStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped_unavailable" | "cancelled";
export type ResearchStepName = "search" | "fetch_originals" | "map_evidence" | "assess";

export interface ResearchRunStep {
  name: ResearchStepName;
  status: RunStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  failureCode: ResearchErrorCode | null;
  providerAvailability: ProviderAvailability | null;
}

export interface ResearchUsage {
  searchRequests: number;
  fetchedPages: number;
  modelInputTokens: number | null;
  modelOutputTokens: number | null;
  /** Null means the configured provider did not report a cost; it is not zero. */
  providerCostMicros: number | null;
  elapsedMilliseconds: number;
}

export type CoverageGapReason =
  | "provider_unavailable"
  | "no_results"
  | "original_unavailable"
  | "source_access_blocked"
  | "search_failed"
  | "fetch_failed"
  | "budget_exhausted"
  | "time_limit"
  | "cancelled"
  | "interrupted"
  | "no_independent_sources";

export interface CoverageGap {
  reason: CoverageGapReason;
  detail: string;
  queryId: string | null;
  hypothesisId: string | null;
}

export type AssessmentOutcome = "supported" | "mixed" | "contradicted" | "insufficient_evidence";

export interface ClaimAssessment {
  hypothesisId: string;
  outcome: AssessmentOutcome;
  rationale: string;
  supportingEvidenceIds: string[];
  challengingEvidenceIds: string[];
  missingEvidence: string[];
}

export interface ResearchAssessment {
  outcome: AssessmentOutcome;
  summary: string;
  rationale: string;
  claims: ClaimAssessment[];
  coverageGaps: CoverageGap[];
  nextExperiment: string;
  /** No numeric probability or uncalibrated market score is part of this contract. */
}

export interface SourceVersionReference {
  /** `source_items:<positive integer>` maps to the legacy SQLite source_items.id. */
  sourceId: string;
  canonicalUrl: string;
  retrievedAt: string;
}

/** Grounding fields intentionally match the existing EvidenceExcerptV1 format. */
export interface VerifiedExcerptV1 {
  version: 1;
  sourceItemId: number;
  /** `claim` is specific to hypothesis research; the legacy excerpt format is unchanged. */
  role: "pain" | "workaround" | "wtp" | "time_loss" | "claim";
  quote: string;
  sourceTextHash: string;
  /** Zero-based UTF-16 code-unit offsets; end is exclusive. */
  startUtf16: number;
  endUtf16: number;
}

export interface VerifiedEvidenceLink {
  kind: "verified_excerpt";
  evidenceId: string;
  hypothesisId: string;
  relationship: "supports" | "contradicts" | "context";
  source: SourceVersionReference;
  excerpt: VerifiedExcerptV1;
  verification: "matched_to_fetched_original";
  interpretation: string;
  /** Multiple links from one source version count as one independent source. */
  independenceGroupId: string;
  /** True when author-level independence has not been established for this source group. */
  independenceUncertain?: boolean;
}

export interface DiscoverySnippet {
  kind: "search_snippet";
  snippetId: string;
  queryId: string;
  sourceUrl: string;
  text: string;
  /** Snippets can guide retrieval but can never support an assessment. */
  assessmentEligible: false;
}

export type ResearchEvidence = VerifiedEvidenceLink | DiscoverySnippet;

export interface ResearchCaseRunSnapshot {
  caseRevision: ResearchCaseRevision;
  plan: ResearchPlanSnapshot;
}

export type RunStoppingReason =
  | "all_steps_finished"
  | "cancelled"
  | "provider_unavailable"
  | "limit_reached"
  | "deadline_reached"
  | "step_failed"
  | "service_shutdown"
  | "lease_lost";

export interface ResearchRun {
  runId: string;
  caseId: string;
  caseRevision: number;
  planId: string;
  status: RunExecutionStatus;
  snapshot: ResearchCaseRunSnapshot;
  steps: ResearchRunStep[];
  usage: ResearchUsage;
  assessment: ResearchAssessment | null;
  coverageGaps: CoverageGap[];
  stoppingReason: RunStoppingReason | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
}

/** Internal lease record; never returned by a tool or written to routine logs. */
export interface WorkspaceRunLease {
  workspaceKey: string;
  runId: string;
  ownerInstanceId: string;
  /** Monotonically increasing fencing epoch for this workspace. */
  fencingToken: number;
  expiresAt: string;
  renewedAt: string;
}

export type ProviderAvailability = "available" | "not_configured" | "unavailable";
export type ResearchCapability = "model" | "search" | "original_source_fetch";

export interface CapabilityStatus {
  availability: ProviderAvailability;
  /** Non-secret adapter family only; omit when unavailable. */
  adapter: string | null;
}

export interface ResearchCapabilities {
  capabilities: Record<ResearchCapability, CapabilityStatus>;
  limits: ResearchLimits;
  storageMode: "single_owner_workspace";
}

export interface ResearchSuccess<T> {
  schemaVersion: typeof RESEARCH_SCHEMA_VERSION;
  data: T;
}

export type ResearchErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "BUSY"
  | "PROVIDER_UNAVAILABLE"
  | "LIMIT_EXCEEDED"
  | "RUN_NOT_CANCELLABLE"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export interface ValidationIssue {
  path: string;
  code: "missing" | "unknown_key" | "invalid_type" | "out_of_range" | "invalid_value" | "inconsistent";
}

export type ResearchErrorDetails =
  | { kind: "validation"; issues: ValidationIssue[] }
  | { kind: "not_found"; resource: "case" | "plan" | "hypothesis" | "run"; id: string }
  | { kind: "revision_conflict"; caseId: string; expectedRevision: number; currentRevision: number }
  | { kind: "plan_revision_conflict"; caseId: string; planId: string; expectedCaseRevision: number; planCaseRevision: number; currentCaseRevision: number }
  | { kind: "hypothesis_revision_conflict"; caseId: string; hypothesisId: string; expectedRevision: number; currentRevision: number }
  | { kind: "idempotency_conflict"; operation: WriteOperation }
  | { kind: "busy"; activeRunId: string }
  | { kind: "provider_unavailable"; capability: ResearchCapability; availability: ProviderAvailability }
  | { kind: "limit_exceeded"; limitName: keyof ResearchLimits; limit: number; requested: number }
  | { kind: "run_not_cancellable"; runId: string; status: RunExecutionStatus }
  | { kind: "access_denied"; reason: "authentication" | "origin" | "host" }
  | { kind: "rate_limited"; retryAfterSeconds: number | null }
  | { kind: "internal" };

export interface ResearchFailure {
  schemaVersion: typeof RESEARCH_SCHEMA_VERSION;
  error: {
    code: ResearchErrorCode;
    message: string;
    retryable: boolean;
    details: ResearchErrorDetails;
  };
}

export type ResearchResponse<T> = ResearchSuccess<T> | ResearchFailure;
export type WriteOperation = "research_case_create" | "research_case_update" | "research_plan" | "research_start" | "research_cancel";

export interface IdempotencyInput {
  /** Required for every write. Scope is the bound workspace plus operation name. */
  idempotencyKey: string;
}

export interface CaseCreateInput extends IdempotencyInput {
  intake?: ResearchIntake;
  hypotheses?: HypothesisSubmission[];
}

/** Model-suggested claims retain provenance when explicitly accepted by ID. */
export type HypothesisSubmission =
  | { claim: string; origin?: "user_supplied" }
  | { claim: string; origin: "model_suggested"; sourceSuggestionId: string };

export interface CaseGetInput {
  caseId: string;
  /** Omitted returns the latest revision; a supplied revision reads that snapshot. */
  revision?: number;
}

export type HypothesisMutation =
  | ({ operation: "add"; clientRef: string } & HypothesisSubmission)
  | { operation: "revise"; hypothesisId: string; expectedRevision: number; claim: string }
  | { operation: "retire"; hypothesisId: string; expectedRevision: number };

export interface CaseUpdateInput extends IdempotencyInput {
  caseId: string;
  expectedRevision: number;
  /** Omitted fields are preserved; null clears a scalar field or records unknown. */
  intakePatch?: ResearchIntake;
  hypothesisMutations?: HypothesisMutation[];
}

export interface PlanInput extends IdempotencyInput {
  caseId: string;
  expectedCaseRevision: number;
  /** Supplied plans are validated locally and require no model provider. */
  suppliedPlan?: ResearchPlanDraft;
  /** Model suggestions are opt-in and remain unaccepted until submitted by the caller. */
  requestHypothesisSuggestions?: boolean;
}

export interface StartRunInput extends IdempotencyInput {
  caseId: string;
  expectedCaseRevision: number;
  planId: string;
}

export interface RunIdInput {
  runId: string;
}

export interface ResultInput extends RunIdInput {
  cursor?: string;
  limit?: number;
  format?: "json" | "markdown";
}

export interface CancelRunInput extends RunIdInput, IdempotencyInput {}

export interface CaseCreateResult {
  case: ResearchCase;
}

export interface CaseUpdateResult {
  case: ResearchCase;
}

export interface PlanResult {
  status: "ready" | "needs_clarification";
  caseId: string;
  caseRevision: number;
  plan: ResearchPlanSnapshot | null;
  missingFields: MissingIntakeField[];
  hypothesisSuggestions: HypothesisSuggestion[];
}

export interface StartRunResult {
  runId: string;
  status: "queued";
  caseId: string;
  caseRevision: number;
  planId: string;
  acceptedAt: string;
}

export interface RunStatusResult {
  runId: string;
  caseId: string;
  caseRevision: number;
  planId: string;
  status: RunExecutionStatus;
  steps: ResearchRunStep[];
  usage: ResearchUsage;
  coverageGaps: CoverageGap[];
  stoppingReason: RunStoppingReason | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
}

export interface ResearchResultPage {
  runId: string;
  assessment: ResearchAssessment | null;
  evidence: ResearchEvidence[];
  coverageGaps: CoverageGap[];
  pagination: {
    nextCursor: string | null;
    hasMore: boolean;
    totalEvidence: number;
  };
  /** Markdown renders only the same assessment and evidence returned on this page. */
  reportMarkdown: string | null;
}

export interface CancelRunResult {
  runId: string;
  status: RunExecutionStatus;
  cancellationRequested: boolean;
  cancelRequestedAt: string | null;
}

export type ToolInputMap = {
  research_capabilities: Record<string, never>;
  research_case_create: CaseCreateInput;
  research_case_get: CaseGetInput;
  research_case_update: CaseUpdateInput;
  research_plan: PlanInput;
  research_start: StartRunInput;
  research_status: RunIdInput;
  research_result: ResultInput;
  research_cancel: CancelRunInput;
};

export type ToolDataMap = {
  research_capabilities: ResearchCapabilities;
  research_case_create: CaseCreateResult;
  research_case_get: ResearchCase;
  research_case_update: CaseUpdateResult;
  research_plan: PlanResult;
  research_start: StartRunResult;
  research_status: RunStatusResult;
  research_result: ResearchResultPage;
  research_cancel: CancelRunResult;
};

/**
 * An application instance is bound to one explicit workspace context. MCP and
 * CLI adapters call the same methods; transport inputs never select a path,
 * database, workspace, provider, or credential.
 */
export interface ResearchApplication {
  capabilities(): Promise<ResearchResponse<ResearchCapabilities>>;
  createCase(input: CaseCreateInput): Promise<ResearchResponse<CaseCreateResult>>;
  getCase(input: CaseGetInput): Promise<ResearchResponse<ResearchCase>>;
  updateCase(input: CaseUpdateInput): Promise<ResearchResponse<CaseUpdateResult>>;
  plan(input: PlanInput): Promise<ResearchResponse<PlanResult>>;
  start(input: StartRunInput): Promise<ResearchResponse<StartRunResult>>;
  status(input: RunIdInput): Promise<ResearchResponse<RunStatusResult>>;
  result(input: ResultInput): Promise<ResearchResponse<ResearchResultPage>>;
  cancel(input: CancelRunInput): Promise<ResearchResponse<CancelRunResult>>;
}

export function success<T>(data: T): ResearchSuccess<T> {
  return { schemaVersion: RESEARCH_SCHEMA_VERSION, data };
}
