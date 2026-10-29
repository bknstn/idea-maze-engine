import {
  RESEARCH_SCHEMA_VERSION,
  type ToolDataMap,
  type ToolInputMap,
} from "./contracts.js";

export interface JsonSchema {
  $schema?: string;
  $defs?: Record<string, JsonSchema>;
  $ref?: string;
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minProperties?: number;
  uniqueItems?: boolean;
  format?: string;
}

export interface ResearchToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ResearchToolDefinition<TName extends keyof ToolInputMap = keyof ToolInputMap> {
  name: TName;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: ResearchToolAnnotations;
}

const ID: JsonSchema = { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
const REVISION: JsonSchema = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const IDEMPOTENCY_KEY: JsonSchema = { type: "string", minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$" };
const SHORT_TEXT: JsonSchema = { type: "string", minLength: 1, maxLength: 300 };
const CLAIM: JsonSchema = { type: "string", minLength: 8, maxLength: 1000 };
const STRING_ARRAY = (maxItems: number, maxLength: number): JsonSchema => ({
  type: "array", minItems: 0, maxItems, uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength },
});
const NULLABLE_TEXT = (maxLength: number): JsonSchema => ({ type: ["string", "null"], minLength: 1, maxLength });

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const INTAKE_SCHEMA = objectSchema({
  ideaSummary: NULLABLE_TEXT(1200),
  targetUser: NULLABLE_TEXT(800),
  problem: NULLABLE_TEXT(800),
  proposedSolution: NULLABLE_TEXT(800),
  currentAlternatives: { anyOf: [STRING_ARRAY(10, 300), { type: "null" }] },
  usageFrequency: NULLABLE_TEXT(800),
  budgetOrWillingnessToPay: NULLABLE_TEXT(800),
  decisionMaker: NULLABLE_TEXT(800),
  constraints: { anyOf: [STRING_ARRAY(10, 300), { type: "null" }] },
});

const HYPOTHESIS_USER_SUBMISSION = (leading: Record<string, JsonSchema>): JsonSchema => ({
  oneOf: [
    objectSchema({ ...leading, claim: CLAIM }, [...Object.keys(leading), "claim"]),
    objectSchema({ ...leading, claim: CLAIM, origin: { const: "user_supplied" } }, [...Object.keys(leading), "claim", "origin"]),
    objectSchema({
      ...leading,
      claim: CLAIM,
      origin: { const: "model_suggested" },
      sourceSuggestionId: ID,
    }, [...Object.keys(leading), "claim", "origin", "sourceSuggestionId"]),
  ],
});

const LIMITS_SCHEMA = objectSchema({
  maxQueries: { type: "integer", minimum: 1, maximum: 40 },
  maxFetchedPages: { type: "integer", minimum: 1, maximum: 100 },
  maxFollowUpRounds: { type: "integer", minimum: 0, maximum: 3 },
  maxWallTimeSeconds: { type: "integer", minimum: 1, maximum: 900 },
  maxModelInputTokens: { type: "integer", minimum: 1, maximum: 20000 },
  maxModelOutputTokens: { type: "integer", minimum: 1, maximum: 20000 },
}, ["maxQueries", "maxFetchedPages", "maxFollowUpRounds", "maxWallTimeSeconds", "maxModelInputTokens", "maxModelOutputTokens"]);

const QUERY_SCHEMA = objectSchema({
  text: { type: "string", minLength: 2, maxLength: 240 },
  purpose: { type: "string", enum: ["problem_language", "workaround", "alternative", "counterevidence"] },
  evidenceIntent: { type: "string", enum: ["supporting", "challenging", "context"] },
  hypothesisIds: { ...STRING_ARRAY(20, 128), minItems: 1 },
  sourceScopes: {
    type: "array", minItems: 1, maxItems: 3, uniqueItems: true,
    items: { type: "string", enum: ["public_web", "public_reddit", "community_discussions"] },
  },
}, ["text", "purpose", "evidenceIntent", "hypothesisIds", "sourceScopes"]);

const PLAN_DRAFT_SCHEMA = objectSchema({
  queries: { type: "array", minItems: 1, maxItems: 40, items: QUERY_SCHEMA },
  limits: LIMITS_SCHEMA,
}, ["queries", "limits"]);

const HYPOTHESIS_MUTATION_SCHEMA: JsonSchema = {
  oneOf: [
    HYPOTHESIS_USER_SUBMISSION({ operation: { const: "add" }, clientRef: ID }),
    objectSchema({ operation: { const: "revise" }, hypothesisId: ID, expectedRevision: REVISION, claim: CLAIM }, ["operation", "hypothesisId", "expectedRevision", "claim"]),
    objectSchema({ operation: { const: "retire" }, hypothesisId: ID, expectedRevision: REVISION }, ["operation", "hypothesisId", "expectedRevision"]),
  ],
};

const EMPTY_INPUT = objectSchema({});
const CREATE_INPUT = objectSchema({
  idempotencyKey: IDEMPOTENCY_KEY,
  intake: INTAKE_SCHEMA,
  hypotheses: { type: "array", minItems: 0, maxItems: 20, items: HYPOTHESIS_USER_SUBMISSION({}) },
}, ["idempotencyKey"]);
const GET_CASE_INPUT = objectSchema({ caseId: ID, revision: REVISION }, ["caseId"]);
const UPDATE_INPUT = objectSchema({
  idempotencyKey: IDEMPOTENCY_KEY,
  caseId: ID,
  expectedRevision: REVISION,
  intakePatch: { ...INTAKE_SCHEMA, minProperties: 1 },
  hypothesisMutations: { type: "array", minItems: 1, maxItems: 20, items: HYPOTHESIS_MUTATION_SCHEMA },
}, ["idempotencyKey", "caseId", "expectedRevision"]);
const PLAN_INPUT = objectSchema({
  idempotencyKey: IDEMPOTENCY_KEY,
  caseId: ID,
  expectedCaseRevision: REVISION,
  suppliedPlan: PLAN_DRAFT_SCHEMA,
  requestHypothesisSuggestions: { type: "boolean" },
}, ["idempotencyKey", "caseId", "expectedCaseRevision"]);
const START_INPUT = objectSchema({
  idempotencyKey: IDEMPOTENCY_KEY,
  caseId: ID,
  expectedCaseRevision: REVISION,
  planId: ID,
}, ["idempotencyKey", "caseId", "expectedCaseRevision", "planId"]);
const RUN_ID_INPUT = objectSchema({ runId: ID }, ["runId"]);
const RESULT_INPUT = objectSchema({
  runId: ID,
  cursor: { type: "string", minLength: 1, maxLength: 512 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
  format: { type: "string", enum: ["json", "markdown"] },
}, ["runId"]);
const CANCEL_INPUT = objectSchema({ runId: ID, idempotencyKey: IDEMPOTENCY_KEY }, ["runId", "idempotencyKey"]);

const TS = { type: "string", format: "date-time" } as const;
const NULLABLE_TS: JsonSchema = { type: ["string", "null"], format: "date-time" };
const HASH = { type: "string", minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" };
const NONEMPTY = { type: "string", minLength: 1, maxLength: 2000 };
const ARRAY_OF = (schema: JsonSchema, maxItems = 1000): JsonSchema => ({ type: "array", maxItems, items: schema });

const RESEARCH_JSON_DEFS: Record<string, JsonSchema> = {
  ResearchLimits: LIMITS_SCHEMA,
  MissingIntakeField: objectSchema({
    field: { type: "string", enum: ["ideaSummary", "targetUser", "problem", "proposedSolution", "currentAlternatives", "usageFrequency", "budgetOrWillingnessToPay", "decisionMaker", "constraints", "hypotheses"] },
    blockingForPlanning: { type: "boolean" },
    clarification: { type: "string", minLength: 1, maxLength: 300 },
  }, ["field", "blockingForPlanning", "clarification"]),
  HypothesisRevision: objectSchema({
    hypothesisId: ID,
    revision: REVISION,
    claim: CLAIM,
    origin: { type: "string", enum: ["user_supplied", "model_suggested"] },
    sourceSuggestionId: { anyOf: [ID, { type: "null" }] },
    state: { type: "string", enum: ["active", "retired"] },
    createdAt: TS,
  }, ["hypothesisId", "revision", "claim", "origin", "sourceSuggestionId", "state", "createdAt"]),
  ResearchCase: objectSchema({
    caseId: ID,
    revision: REVISION,
    status: { type: "string", enum: ["draft", "ready"] },
    intake: INTAKE_SCHEMA,
    hypotheses: ARRAY_OF({ $ref: "#/$defs/HypothesisRevision" }, 20),
    missingFields: ARRAY_OF({ $ref: "#/$defs/MissingIntakeField" }, 10),
    createdAt: TS,
    updatedAt: TS,
  }, ["caseId", "revision", "status", "intake", "hypotheses", "missingFields", "createdAt", "updatedAt"]),
  ResearchQuery: objectSchema({
    queryId: ID,
    text: { type: "string", minLength: 2, maxLength: 240 },
    purpose: { type: "string", enum: ["problem_language", "workaround", "alternative", "counterevidence"] },
    evidenceIntent: { type: "string", enum: ["supporting", "challenging", "context"] },
    hypothesisIds: { ...STRING_ARRAY(20, 128), minItems: 1 },
    sourceScopes: {
      type: "array", minItems: 1, maxItems: 3, uniqueItems: true,
      items: { type: "string", enum: ["public_web", "public_reddit", "community_discussions"] },
    },
  }, ["queryId", "text", "purpose", "evidenceIntent", "hypothesisIds", "sourceScopes"]),
  ResearchPlan: objectSchema({
    planId: ID,
    caseId: ID,
    caseRevision: REVISION,
    queries: ARRAY_OF({ $ref: "#/$defs/ResearchQuery" }, 40),
    limits: { $ref: "#/$defs/ResearchLimits" },
    createdAt: TS,
  }, ["planId", "caseId", "caseRevision", "queries", "limits", "createdAt"]),
  HypothesisSuggestion: objectSchema({
    suggestionId: ID,
    claim: CLAIM,
    origin: { const: "model_suggested" },
    status: { const: "unaccepted_suggestion" },
  }, ["suggestionId", "claim", "origin", "status"]),
  CoverageGap: objectSchema({
    reason: { type: "string", enum: ["provider_unavailable", "no_results", "original_unavailable", "source_access_blocked", "search_failed", "fetch_failed", "budget_exhausted", "time_limit", "cancelled", "interrupted", "no_independent_sources"] },
    detail: { type: "string", minLength: 1, maxLength: 1000 },
    queryId: { anyOf: [ID, { type: "null" }] },
    hypothesisId: { anyOf: [ID, { type: "null" }] },
  }, ["reason", "detail", "queryId", "hypothesisId"]),
  ClaimAssessment: objectSchema({
    hypothesisId: ID,
    outcome: { type: "string", enum: ["supported", "mixed", "contradicted", "insufficient_evidence"] },
    rationale: { type: "string", minLength: 1, maxLength: 2000 },
    supportingEvidenceIds: ARRAY_OF(ID, 1000),
    challengingEvidenceIds: ARRAY_OF(ID, 1000),
    missingEvidence: ARRAY_OF({ type: "string", minLength: 1, maxLength: 500 }, 100),
  }, ["hypothesisId", "outcome", "rationale", "supportingEvidenceIds", "challengingEvidenceIds", "missingEvidence"]),
  Assessment: objectSchema({
    outcome: { type: "string", enum: ["supported", "mixed", "contradicted", "insufficient_evidence"] },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    rationale: { type: "string", minLength: 1, maxLength: 4000 },
    claims: ARRAY_OF({ $ref: "#/$defs/ClaimAssessment" }, 20),
    coverageGaps: ARRAY_OF({ $ref: "#/$defs/CoverageGap" }, 1000),
    nextExperiment: { type: "string", minLength: 1, maxLength: 2000 },
  }, ["outcome", "summary", "rationale", "claims", "coverageGaps", "nextExperiment"]),
  SourceReference: objectSchema({
    sourceId: ID,
    canonicalUrl: { type: "string", minLength: 1, maxLength: 2048, format: "uri" },
    retrievedAt: TS,
  }, ["sourceId", "canonicalUrl", "retrievedAt"]),
  VerifiedExcerptV1: objectSchema({
    version: { const: 1 },
    sourceItemId: { type: "integer", minimum: 1 },
    role: { type: "string", enum: ["pain", "workaround", "wtp", "time_loss", "claim"] },
    quote: { type: "string", minLength: 1, maxLength: 800 },
    sourceTextHash: HASH,
    startUtf16: { type: "integer", minimum: 0 },
    endUtf16: { type: "integer", minimum: 1 },
  }, ["version", "sourceItemId", "role", "quote", "sourceTextHash", "startUtf16", "endUtf16"]),
  VerifiedEvidence: objectSchema({
    kind: { const: "verified_excerpt" },
    evidenceId: ID,
    hypothesisId: ID,
    relationship: { type: "string", enum: ["supports", "contradicts", "context"] },
    source: { $ref: "#/$defs/SourceReference" },
    excerpt: { $ref: "#/$defs/VerifiedExcerptV1" },
    verification: { const: "matched_to_fetched_original" },
    interpretation: { type: "string", minLength: 1, maxLength: 2000 },
    independenceGroupId: ID,
    independenceUncertain: { type: "boolean" },
  }, ["kind", "evidenceId", "hypothesisId", "relationship", "source", "excerpt", "verification", "interpretation", "independenceGroupId"]),
  DiscoverySnippet: objectSchema({
    kind: { const: "search_snippet" },
    snippetId: ID,
    queryId: ID,
    sourceUrl: { type: "string", minLength: 1, maxLength: 2048, format: "uri" },
    text: { type: "string", minLength: 1, maxLength: 2000 },
    assessmentEligible: { const: false },
  }, ["kind", "snippetId", "queryId", "sourceUrl", "text", "assessmentEligible"]),
  ResearchEvidence: { oneOf: [{ $ref: "#/$defs/VerifiedEvidence" }, { $ref: "#/$defs/DiscoverySnippet" }] },
  ResearchStep: objectSchema({
    name: { type: "string", enum: ["search", "fetch_originals", "map_evidence", "assess"] },
    status: { type: "string", enum: ["pending", "running", "succeeded", "failed", "skipped_unavailable", "cancelled"] },
    startedAt: NULLABLE_TS,
    finishedAt: NULLABLE_TS,
    failureCode: { anyOf: [{ type: "string", enum: ["VALIDATION_ERROR", "NOT_FOUND", "REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT", "BUSY", "PROVIDER_UNAVAILABLE", "LIMIT_EXCEEDED", "RUN_NOT_CANCELLABLE", "UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED", "INTERNAL_ERROR"] }, { type: "null" }] },
    providerAvailability: { anyOf: [{ type: "string", enum: ["available", "not_configured", "unavailable"] }, { type: "null" }] },
  }, ["name", "status", "startedAt", "finishedAt", "failureCode", "providerAvailability"]),
  Usage: objectSchema({
    searchRequests: { type: "integer", minimum: 0 },
    fetchedPages: { type: "integer", minimum: 0 },
    modelInputTokens: { type: ["integer", "null"], minimum: 0 },
    modelOutputTokens: { type: ["integer", "null"], minimum: 0 },
    providerCostMicros: { type: ["integer", "null"], minimum: 0 },
    elapsedMilliseconds: { type: "integer", minimum: 0 },
  }, ["searchRequests", "fetchedPages", "modelInputTokens", "modelOutputTokens", "providerCostMicros", "elapsedMilliseconds"]),
  RunStatus: objectSchema({
    runId: ID,
    caseId: ID,
    caseRevision: REVISION,
    planId: ID,
    status: { type: "string", enum: ["queued", "running", "cancellation_requested", "completed", "failed", "cancelled", "interrupted"] },
    steps: ARRAY_OF({ $ref: "#/$defs/ResearchStep" }, 4),
    usage: { $ref: "#/$defs/Usage" },
    coverageGaps: ARRAY_OF({ $ref: "#/$defs/CoverageGap" }, 1000),
    stoppingReason: { anyOf: [{ type: "string", enum: ["all_steps_finished", "cancelled", "provider_unavailable", "limit_reached", "deadline_reached", "step_failed", "service_shutdown", "lease_lost"] }, { type: "null" }] },
    createdAt: TS,
    startedAt: NULLABLE_TS,
    finishedAt: NULLABLE_TS,
    cancelRequestedAt: NULLABLE_TS,
  }, ["runId", "caseId", "caseRevision", "planId", "status", "steps", "usage", "coverageGaps", "stoppingReason", "createdAt", "startedAt", "finishedAt", "cancelRequestedAt"]),
  ResearchCapabilities: objectSchema({
    capabilities: objectSchema({
      model: { $ref: "#/$defs/CapabilityStatus" },
      search: { $ref: "#/$defs/CapabilityStatus" },
      original_source_fetch: { $ref: "#/$defs/CapabilityStatus" },
    }, ["model", "search", "original_source_fetch"]),
    limits: { $ref: "#/$defs/ResearchLimits" },
    storageMode: { const: "single_owner_workspace" },
  }, ["capabilities", "limits", "storageMode"]),
  CapabilityStatus: objectSchema({
    availability: { type: "string", enum: ["available", "not_configured", "unavailable"] },
    adapter: { anyOf: [{ type: "string", minLength: 1, maxLength: 64 }, { type: "null" }] },
  }, ["availability", "adapter"]),
  CaseCreateData: objectSchema({ case: { $ref: "#/$defs/ResearchCase" } }, ["case"]),
  CaseUpdateData: objectSchema({ case: { $ref: "#/$defs/ResearchCase" } }, ["case"]),
  PlanData: objectSchema({
    status: { type: "string", enum: ["ready", "needs_clarification"] },
    caseId: ID,
    caseRevision: REVISION,
    plan: { anyOf: [{ $ref: "#/$defs/ResearchPlan" }, { type: "null" }] },
    missingFields: ARRAY_OF({ $ref: "#/$defs/MissingIntakeField" }, 10),
    hypothesisSuggestions: ARRAY_OF({ $ref: "#/$defs/HypothesisSuggestion" }, 20),
  }, ["status", "caseId", "caseRevision", "plan", "missingFields", "hypothesisSuggestions"]),
  StartData: objectSchema({
    runId: ID,
    status: { const: "queued" },
    caseId: ID,
    caseRevision: REVISION,
    planId: ID,
    acceptedAt: TS,
  }, ["runId", "status", "caseId", "caseRevision", "planId", "acceptedAt"]),
  ResultData: objectSchema({
    runId: ID,
    assessment: { anyOf: [{ $ref: "#/$defs/Assessment" }, { type: "null" }] },
    evidence: ARRAY_OF({ $ref: "#/$defs/ResearchEvidence" }, 100),
    coverageGaps: ARRAY_OF({ $ref: "#/$defs/CoverageGap" }, 1000),
    pagination: objectSchema({
      nextCursor: { anyOf: [{ type: "string", minLength: 1, maxLength: 512 }, { type: "null" }] },
      hasMore: { type: "boolean" },
      totalEvidence: { type: "integer", minimum: 0 },
    }, ["nextCursor", "hasMore", "totalEvidence"]),
    reportMarkdown: { anyOf: [{ type: "string", maxLength: 30000 }, { type: "null" }] },
  }, ["runId", "assessment", "evidence", "coverageGaps", "pagination", "reportMarkdown"]),
  CancelData: objectSchema({
    runId: ID,
    status: { type: "string", enum: ["queued", "running", "cancellation_requested", "completed", "failed", "cancelled", "interrupted"] },
    cancellationRequested: { type: "boolean" },
    cancelRequestedAt: NULLABLE_TS,
  }, ["runId", "status", "cancellationRequested", "cancelRequestedAt"]),
  ErrorEnvelope: objectSchema({
    schemaVersion: { const: RESEARCH_SCHEMA_VERSION },
    error: objectSchema({
      code: { type: "string", enum: ["VALIDATION_ERROR", "NOT_FOUND", "REVISION_CONFLICT", "IDEMPOTENCY_CONFLICT", "BUSY", "PROVIDER_UNAVAILABLE", "LIMIT_EXCEEDED", "RUN_NOT_CANCELLABLE", "UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED", "INTERNAL_ERROR"] },
      message: { type: "string", minLength: 1, maxLength: 512 },
      retryable: { type: "boolean" },
      details: { $ref: "#/$defs/ErrorDetails" },
    }, ["code", "message", "retryable", "details"]),
  }, ["schemaVersion", "error"]),
  ErrorDetails: {
    oneOf: [
      objectSchema({
        kind: { const: "validation" },
        issues: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: objectSchema({
            path: { type: "string", minLength: 1, maxLength: 256 },
            code: { type: "string", enum: ["missing", "unknown_key", "invalid_type", "out_of_range", "invalid_value", "inconsistent"] },
          }, ["path", "code"]),
        },
      }, ["kind", "issues"]),
      objectSchema({ kind: { const: "not_found" }, resource: { type: "string", enum: ["case", "plan", "hypothesis", "run"] }, id: ID }, ["kind", "resource", "id"]),
      objectSchema({ kind: { const: "revision_conflict" }, caseId: ID, expectedRevision: REVISION, currentRevision: REVISION }, ["kind", "caseId", "expectedRevision", "currentRevision"]),
      objectSchema({ kind: { const: "plan_revision_conflict" }, caseId: ID, planId: ID, expectedCaseRevision: REVISION, planCaseRevision: REVISION, currentCaseRevision: REVISION }, ["kind", "caseId", "planId", "expectedCaseRevision", "planCaseRevision", "currentCaseRevision"]),
      objectSchema({ kind: { const: "hypothesis_revision_conflict" }, caseId: ID, hypothesisId: ID, expectedRevision: REVISION, currentRevision: REVISION }, ["kind", "caseId", "hypothesisId", "expectedRevision", "currentRevision"]),
      objectSchema({ kind: { const: "idempotency_conflict" }, operation: { type: "string", enum: ["research_case_create", "research_case_update", "research_plan", "research_start", "research_cancel"] } }, ["kind", "operation"]),
      objectSchema({ kind: { const: "busy" }, activeRunId: ID }, ["kind", "activeRunId"]),
      objectSchema({ kind: { const: "provider_unavailable" }, capability: { type: "string", enum: ["model", "search", "original_source_fetch"] }, availability: { type: "string", enum: ["available", "not_configured", "unavailable"] } }, ["kind", "capability", "availability"]),
      objectSchema({ kind: { const: "limit_exceeded" }, limitName: { type: "string", enum: ["maxQueries", "maxFetchedPages", "maxFollowUpRounds", "maxWallTimeSeconds", "maxModelInputTokens", "maxModelOutputTokens"] }, limit: { type: "integer", minimum: 0 }, requested: { type: "integer", minimum: 0 } }, ["kind", "limitName", "limit", "requested"]),
      objectSchema({ kind: { const: "run_not_cancellable" }, runId: ID, status: { type: "string", enum: ["queued", "running", "cancellation_requested", "completed", "failed", "cancelled", "interrupted"] } }, ["kind", "runId", "status"]),
      objectSchema({ kind: { const: "access_denied" }, reason: { type: "string", enum: ["authentication", "origin", "host"] } }, ["kind", "reason"]),
      objectSchema({ kind: { const: "rate_limited" }, retryAfterSeconds: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] } }, ["kind", "retryAfterSeconds"]),
      objectSchema({ kind: { const: "internal" } }, ["kind"]),
    ],
  },
};

function outputSchema(dataDefinition: string): JsonSchema {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: RESEARCH_JSON_DEFS,
    oneOf: [
      objectSchema({
        schemaVersion: { const: RESEARCH_SCHEMA_VERSION },
        data: { $ref: `#/$defs/${dataDefinition}` },
      }, ["schemaVersion", "data"]),
      { $ref: "#/$defs/ErrorEnvelope" },
    ],
  };
}

const annotations = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  localWrite: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  externalWrite: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  cancel: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
} satisfies Record<string, ResearchToolAnnotations>;

export const RESEARCH_TOOL_DEFINITIONS = [
  {
    name: "research_capabilities",
    title: "Research capabilities",
    description: "Read configured capabilities and hard limits. Never returns credentials or starts work.",
    inputSchema: EMPTY_INPUT,
    outputSchema: outputSchema("ResearchCapabilities"),
    annotations: annotations.read,
  },
  {
    name: "research_case_create",
    title: "Create research case",
    description: "Save a draft or ready case with optional hypotheses. Missing intake fields remain explicit. Requires an idempotency key.",
    inputSchema: CREATE_INPUT,
    outputSchema: outputSchema("CaseCreateData"),
    annotations: annotations.localWrite,
  },
  {
    name: "research_case_get",
    title: "Get research case",
    description: "Read the latest case revision or a specific immutable historical revision.",
    inputSchema: GET_CASE_INPUT,
    outputSchema: outputSchema("ResearchCase"),
    annotations: annotations.read,
  },
  {
    name: "research_case_update",
    title: "Update research case",
    description: "Create a new case revision with optimistic concurrency. Prior revisions and run snapshots remain unchanged. Requires an idempotency key.",
    inputSchema: UPDATE_INPUT,
    outputSchema: outputSchema("CaseUpdateData"),
    annotations: annotations.localWrite,
  },
  {
    name: "research_plan",
    title: "Plan hypothesis research",
    description: "Validate a bounded supplied plan locally, or generate a plan with the configured model. Returns missing intake fields; optional model suggestions remain unaccepted until submitted with their suggestion IDs. Requires an idempotency key.",
    inputSchema: PLAN_INPUT,
    outputSchema: outputSchema("PlanData"),
    annotations: annotations.externalWrite,
  },
  {
    name: "research_start",
    title: "Start research run",
    description: "Start service-owned work from the exact case revision and saved plan, then promptly return a run ID. One active run per workspace; retries with an identical key and payload replay the existing receipt. Requires an idempotency key.",
    inputSchema: START_INPUT,
    outputSchema: outputSchema("StartData"),
    annotations: annotations.externalWrite,
  },
  {
    name: "research_status",
    title: "Get research status",
    description: "Read run state, step outcomes, coverage gaps, and usage. Execution completion is separate from the assessment outcome.",
    inputSchema: RUN_ID_INPUT,
    outputSchema: outputSchema("RunStatus"),
    annotations: annotations.read,
  },
  {
    name: "research_result",
    title: "Read research result",
    description: "Read the assessment and a bounded page of evidence. Continue with the opaque cursor; search snippets are never assessment evidence. Markdown, when requested, renders only the same returned report model and page.",
    inputSchema: RESULT_INPUT,
    outputSchema: outputSchema("ResultData"),
    annotations: annotations.read,
  },
  {
    name: "research_cancel",
    title: "Cancel research run",
    description: "Request cancellation of service-owned work. A terminal run is returned unchanged. Disconnecting the HTTP client is not cancellation. Requires an idempotency key.",
    inputSchema: CANCEL_INPUT,
    outputSchema: outputSchema("CancelData"),
    annotations: annotations.cancel,
  },
] as const satisfies readonly ResearchToolDefinition[];

export type ResearchToolName = typeof RESEARCH_TOOL_DEFINITIONS[number]["name"];

export function getResearchToolDefinition<TName extends ResearchToolName>(name: TName) {
  return RESEARCH_TOOL_DEFINITIONS.find((definition) => definition.name === name);
}

/** Compile-time assertion that every named tool has typed application data. */
export type ResearchToolPayload<TName extends keyof ToolDataMap> = ToolDataMap[TName];

// Keep the exported contract version visible in tooling bundles for clients.
export const RESEARCH_TOOL_SCHEMA_VERSION = RESEARCH_SCHEMA_VERSION;
