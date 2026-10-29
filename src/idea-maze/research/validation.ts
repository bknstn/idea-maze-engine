import {
  type CaseCreateInput,
  type CaseGetInput,
  type CaseUpdateInput,
  type CancelRunInput,
  type HypothesisMutation,
  type HypothesisSubmission,
  type IntakeField,
  type MissingIntakeField,
  type PlanInput,
  type ResearchIntake,
  type ResearchLimits,
  type ResearchPlanDraft,
  type ResultInput,
  type RunIdInput,
  type StartRunInput,
  type ToolInputMap,
  type ValidationIssue,
  type WriteOperation,
  RESEARCH_SCHEMA_VERSION,
} from "./contracts.js";

export const RESEARCH_LIMIT_CEILINGS: Readonly<ResearchLimits> = Object.freeze({
  maxQueries: 40,
  maxFetchedPages: 100,
  maxFollowUpRounds: 3,
  maxWallTimeSeconds: 900,
  maxModelInputTokens: 20_000,
  maxModelOutputTokens: 20_000,
});

const INTAKE_FIELDS: readonly IntakeField[] = [
  "ideaSummary",
  "targetUser",
  "problem",
  "proposedSolution",
  "currentAlternatives",
  "usageFrequency",
  "budgetOrWillingnessToPay",
  "decisionMaker",
  "constraints",
  "hypotheses",
];

const INTAKE_CLARIFICATIONS: Record<IntakeField, { blocking: boolean; prompt: string }> = {
  ideaSummary: { blocking: true, prompt: "Describe the idea in one or two sentences." },
  targetUser: { blocking: true, prompt: "Who is the intended user or buyer?" },
  problem: { blocking: true, prompt: "What problem or job should be addressed?" },
  proposedSolution: { blocking: true, prompt: "What solution are you proposing?" },
  currentAlternatives: { blocking: false, prompt: "What do people use or do today instead?" },
  usageFrequency: { blocking: false, prompt: "How often does the problem or job occur?" },
  budgetOrWillingnessToPay: { blocking: false, prompt: "What budget or willingness to pay is known?" },
  decisionMaker: { blocking: false, prompt: "Who decides whether to adopt or pay?" },
  constraints: { blocking: false, prompt: "What technical, legal, or operational constraints are known?" },
  hypotheses: { blocking: true, prompt: "Add at least one testable hypothesis or request labeled suggestions." },
};

export class ContractValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(path: string, code: ValidationIssue["code"]) {
    super("The request does not match the research contract.");
    this.name = "ContractValidationError";
    this.issues = [{ path: path.slice(0, 256), code }];
  }
}

export function validationFailure(error: ContractValidationError) {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: {
      code: "VALIDATION_ERROR" as const,
      message: "The request does not match the research contract.",
      retryable: false,
      details: { kind: "validation" as const, issues: error.issues },
    },
  };
}

function invalid(path: string, code: ValidationIssue["code"]): never {
  throw new ContractValidationError(path || "$", code);
}

function object(value: unknown, path: string, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path, "invalid_type");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    // Do not reflect attacker-chosen property names into the public error body.
    if (!allowed.includes(key)) invalid(path ? `${path}.*` : "*", "unknown_key");
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) invalid(path ? `${path}.${key}` : key, "missing");
  }
  return record;
}

function text(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== "string") invalid(path, "invalid_type");
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    invalid(path, "out_of_range");
  }
  return trimmed;
}

function nullableText(value: unknown, path: string, max: number): string | null {
  if (value === null) return null;
  return text(value, path, 1, max);
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) invalid(path, "invalid_type");
  if (value < min || value > max) invalid(path, "out_of_range");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "invalid_type");
  return value;
}

function choice<T extends string>(value: unknown, path: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) invalid(path, "invalid_value");
  return value as T;
}

function array(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) invalid(path, "invalid_type");
  if (value.length < min || value.length > max) invalid(path, "out_of_range");
  return value;
}

function stringArray(value: unknown, path: string, maxItems: number, maxText: number, minItems = 0): string[] {
  const values = array(value, path, minItems, maxItems).map((item, index) => text(item, `${path}[${index}]`, 1, maxText));
  if (new Set(values).size !== values.length) invalid(path, "invalid_value");
  return values;
}

function idempotency(value: unknown, path = "idempotencyKey"): string {
  const key = text(value, path, 8, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(key)) invalid(path, "invalid_value");
  return key;
}

function identifier(value: unknown, path: string): string {
  const id = text(value, path, 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) invalid(path, "invalid_value");
  return id;
}

function parseIntake(value: unknown, path: string): ResearchIntake {
  const fields = [
    "ideaSummary", "targetUser", "problem", "proposedSolution", "currentAlternatives",
    "usageFrequency", "budgetOrWillingnessToPay", "decisionMaker", "constraints",
  ] as const;
  const record = object(value, path, fields);
  const parsed: ResearchIntake = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
    const fieldPath = `${path}.${field}`;
    if (field === "currentAlternatives" || field === "constraints") {
      const raw = record[field];
      if (raw === null) {
        parsed[field] = null;
      } else {
        parsed[field] = stringArray(raw, fieldPath, 10, 300);
      }
    } else {
      parsed[field] = nullableText(record[field], fieldPath, field === "ideaSummary" ? 1200 : 800);
    }
  }
  return parsed;
}

function parseLimits(value: unknown, path: string): ResearchLimits {
  const fields = Object.keys(RESEARCH_LIMIT_CEILINGS) as Array<keyof ResearchLimits>;
  const record = object(value, path, fields, fields);
  const limits: ResearchLimits = {
    maxQueries: integer(record.maxQueries, `${path}.maxQueries`, 1, RESEARCH_LIMIT_CEILINGS.maxQueries),
    maxFetchedPages: integer(record.maxFetchedPages, `${path}.maxFetchedPages`, 1, RESEARCH_LIMIT_CEILINGS.maxFetchedPages),
    maxFollowUpRounds: integer(record.maxFollowUpRounds, `${path}.maxFollowUpRounds`, 0, RESEARCH_LIMIT_CEILINGS.maxFollowUpRounds),
    maxWallTimeSeconds: integer(record.maxWallTimeSeconds, `${path}.maxWallTimeSeconds`, 1, RESEARCH_LIMIT_CEILINGS.maxWallTimeSeconds),
    maxModelInputTokens: integer(record.maxModelInputTokens, `${path}.maxModelInputTokens`, 1, RESEARCH_LIMIT_CEILINGS.maxModelInputTokens),
    maxModelOutputTokens: integer(record.maxModelOutputTokens, `${path}.maxModelOutputTokens`, 1, RESEARCH_LIMIT_CEILINGS.maxModelOutputTokens),
  };
  return limits;
}

function parsePlanDraft(value: unknown, path: string): ResearchPlanDraft {
  const record = object(value, path, ["queries", "limits"], ["queries", "limits"]);
  const rawQueries = array(record.queries, `${path}.queries`, 1, RESEARCH_LIMIT_CEILINGS.maxQueries);
  const queries = rawQueries.map((raw, index) => {
    const queryPath = `${path}.queries[${index}]`;
    const query = object(raw, queryPath, ["text", "purpose", "evidenceIntent", "hypothesisIds", "sourceScopes"], ["text", "purpose", "evidenceIntent", "hypothesisIds", "sourceScopes"]);
    const purpose = choice(query.purpose, `${queryPath}.purpose`, ["problem_language", "workaround", "alternative", "counterevidence"] as const);
    const evidenceIntent = choice(query.evidenceIntent, `${queryPath}.evidenceIntent`, ["supporting", "challenging", "context"] as const);
    if (purpose === "counterevidence" && evidenceIntent !== "challenging") invalid(`${queryPath}.evidenceIntent`, "inconsistent");
    return {
      text: text(query.text, `${queryPath}.text`, 2, 240),
      purpose,
      evidenceIntent,
      hypothesisIds: stringArray(query.hypothesisIds, `${queryPath}.hypothesisIds`, 20, 128, 1).map((id, idIndex) => identifier(id, `${queryPath}.hypothesisIds[${idIndex}]`)),
      sourceScopes: stringArray(query.sourceScopes, `${queryPath}.sourceScopes`, 3, 64, 1).map((scope, scopeIndex) => choice(scope, `${queryPath}.sourceScopes[${scopeIndex}]`, ["public_web", "public_reddit", "community_discussions"] as const)),
    };
  });
  const limits = parseLimits(record.limits, `${path}.limits`);
  if (queries.length > limits.maxQueries) invalid(`${path}.queries`, "out_of_range");
  if (new Set(queries.map((query) => query.text.toLocaleLowerCase("en-US"))).size !== queries.length) invalid(`${path}.queries`, "invalid_value");
  return { queries, limits };
}

function parseHypothesisMutations(value: unknown, path: string): HypothesisMutation[] {
  const mutations = array(value, path, 1, 20).map((raw, index): HypothesisMutation => {
    const itemPath = `${path}[${index}]`;
    const rawRecord = object(raw, itemPath, ["operation", "clientRef", "hypothesisId", "expectedRevision", "claim", "origin", "sourceSuggestionId"], ["operation"]);
    const operation = choice(rawRecord.operation, `${itemPath}.operation`, ["add", "revise", "retire"] as const);
    if (operation === "add") {
      const item = object(raw, itemPath, ["operation", "clientRef", "claim", "origin", "sourceSuggestionId"], ["operation", "clientRef", "claim"]);
      const submission = parseHypothesisSubmission(item, itemPath);
      return { operation, clientRef: identifier(item.clientRef, `${itemPath}.clientRef`), ...submission };
    }
    if (operation === "revise") {
      const item = object(raw, itemPath, ["operation", "hypothesisId", "expectedRevision", "claim"], ["operation", "hypothesisId", "expectedRevision", "claim"]);
      return {
        operation,
        hypothesisId: identifier(item.hypothesisId, `${itemPath}.hypothesisId`),
        expectedRevision: integer(item.expectedRevision, `${itemPath}.expectedRevision`, 1, Number.MAX_SAFE_INTEGER),
        claim: text(item.claim, `${itemPath}.claim`, 8, 1000),
      };
    }
    const item = object(raw, itemPath, ["operation", "hypothesisId", "expectedRevision"], ["operation", "hypothesisId", "expectedRevision"]);
    return {
      operation,
      hypothesisId: identifier(item.hypothesisId, `${itemPath}.hypothesisId`),
      expectedRevision: integer(item.expectedRevision, `${itemPath}.expectedRevision`, 1, Number.MAX_SAFE_INTEGER),
    };
  });
  const targets = mutations.map((mutation) => mutation.operation === "add" ? `new:${mutation.clientRef}` : mutation.hypothesisId);
  if (new Set(targets).size !== targets.length) invalid(path, "invalid_value");
  return mutations;
}

function parseHypothesisSubmission(record: Record<string, unknown>, path: string): HypothesisSubmission {
  const claim = text(record.claim, `${path}.claim`, 8, 1000);
  if (!("origin" in record)) {
    if ("sourceSuggestionId" in record) invalid(`${path}.sourceSuggestionId`, "inconsistent");
    return { claim, origin: "user_supplied" };
  }
  const origin = choice(record.origin, `${path}.origin`, ["user_supplied", "model_suggested"] as const);
  if (origin === "user_supplied") {
    if ("sourceSuggestionId" in record) invalid(`${path}.sourceSuggestionId`, "inconsistent");
    return { claim, origin };
  }
  if (!("sourceSuggestionId" in record)) invalid(`${path}.sourceSuggestionId`, "missing");
  return { claim, origin, sourceSuggestionId: identifier(record.sourceSuggestionId, `${path}.sourceSuggestionId`) };
}

function parseCreate(value: unknown): CaseCreateInput {
  const record = object(value, "", ["idempotencyKey", "intake", "hypotheses"], ["idempotencyKey"]);
  const result: CaseCreateInput = { idempotencyKey: idempotency(record.idempotencyKey) };
  if ("intake" in record) result.intake = parseIntake(record.intake, "intake");
  if ("hypotheses" in record) {
    result.hypotheses = array(record.hypotheses, "hypotheses", 0, 20).map((raw, index) => {
      const path = `hypotheses[${index}]`;
      const item = object(raw, path, ["claim", "origin", "sourceSuggestionId"], ["claim"]);
      return parseHypothesisSubmission(item, path);
    });
  }
  return result;
}

function parseGet(value: unknown): CaseGetInput {
  const record = object(value, "", ["caseId", "revision"], ["caseId"]);
  const result: CaseGetInput = { caseId: identifier(record.caseId, "caseId") };
  if ("revision" in record) result.revision = integer(record.revision, "revision", 1, Number.MAX_SAFE_INTEGER);
  return result;
}

function parseUpdate(value: unknown): CaseUpdateInput {
  const record = object(value, "", ["idempotencyKey", "caseId", "expectedRevision", "intakePatch", "hypothesisMutations"], ["idempotencyKey", "caseId", "expectedRevision"]);
  const result: CaseUpdateInput = {
    idempotencyKey: idempotency(record.idempotencyKey),
    caseId: identifier(record.caseId, "caseId"),
    expectedRevision: integer(record.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER),
  };
  if ("intakePatch" in record) result.intakePatch = parseIntake(record.intakePatch, "intakePatch");
  if ("hypothesisMutations" in record) result.hypothesisMutations = parseHypothesisMutations(record.hypothesisMutations, "hypothesisMutations");
  if (!result.intakePatch && !result.hypothesisMutations) invalid("$", "inconsistent");
  if (result.intakePatch && Object.keys(result.intakePatch).length === 0) invalid("intakePatch", "inconsistent");
  return result;
}

function parsePlan(value: unknown): PlanInput {
  const record = object(value, "", ["idempotencyKey", "caseId", "expectedCaseRevision", "suppliedPlan", "requestHypothesisSuggestions"], ["idempotencyKey", "caseId", "expectedCaseRevision"]);
  const result: PlanInput = {
    idempotencyKey: idempotency(record.idempotencyKey),
    caseId: identifier(record.caseId, "caseId"),
    expectedCaseRevision: integer(record.expectedCaseRevision, "expectedCaseRevision", 1, Number.MAX_SAFE_INTEGER),
  };
  if ("suppliedPlan" in record) result.suppliedPlan = parsePlanDraft(record.suppliedPlan, "suppliedPlan");
  if ("requestHypothesisSuggestions" in record) result.requestHypothesisSuggestions = boolean(record.requestHypothesisSuggestions, "requestHypothesisSuggestions");
  return result;
}

function parseStart(value: unknown): StartRunInput {
  const record = object(value, "", ["idempotencyKey", "caseId", "expectedCaseRevision", "planId"], ["idempotencyKey", "caseId", "expectedCaseRevision", "planId"]);
  return {
    idempotencyKey: idempotency(record.idempotencyKey),
    caseId: identifier(record.caseId, "caseId"),
    expectedCaseRevision: integer(record.expectedCaseRevision, "expectedCaseRevision", 1, Number.MAX_SAFE_INTEGER),
    planId: identifier(record.planId, "planId"),
  };
}

function parseRunId(value: unknown): RunIdInput {
  const record = object(value, "", ["runId"], ["runId"]);
  return { runId: identifier(record.runId, "runId") };
}

function parseResult(value: unknown): ResultInput {
  const record = object(value, "", ["runId", "cursor", "limit", "format"], ["runId"]);
  const result: ResultInput = { runId: identifier(record.runId, "runId") };
  if ("cursor" in record) result.cursor = text(record.cursor, "cursor", 1, 512);
  if ("limit" in record) result.limit = integer(record.limit, "limit", 1, 100);
  if ("format" in record) result.format = choice(record.format, "format", ["json", "markdown"] as const);
  return result;
}

function parseCancel(value: unknown): CancelRunInput {
  const record = object(value, "", ["runId", "idempotencyKey"], ["runId", "idempotencyKey"]);
  return { runId: identifier(record.runId, "runId"), idempotencyKey: idempotency(record.idempotencyKey) };
}

export type ResearchToolName = keyof ToolInputMap;

export function validateToolInput<TName extends ResearchToolName>(name: TName, input: unknown): ToolInputMap[TName] {
  let parsed: unknown;
  switch (name) {
    case "research_capabilities":
      object(input, "", []);
      parsed = {};
      break;
    case "research_case_create": parsed = parseCreate(input); break;
    case "research_case_get": parsed = parseGet(input); break;
    case "research_case_update": parsed = parseUpdate(input); break;
    case "research_plan": parsed = parsePlan(input); break;
    case "research_start": parsed = parseStart(input); break;
    case "research_status": parsed = parseRunId(input); break;
    case "research_result": parsed = parseResult(input); break;
    case "research_cancel": parsed = parseCancel(input); break;
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
  return parsed as ToolInputMap[TName];
}

export function getMissingIntakeFields(intake: ResearchIntake, activeHypothesisCount: number): MissingIntakeField[] {
  const absent = (key: keyof ResearchIntake) => intake[key] === undefined || intake[key] === null;
  const missing = INTAKE_FIELDS.filter((field) => {
    if (field === "hypotheses") return activeHypothesisCount === 0;
    return absent(field as keyof ResearchIntake);
  });
  return missing.map((field) => ({
    field,
    blockingForPlanning: INTAKE_CLARIFICATIONS[field].blocking,
    clarification: INTAKE_CLARIFICATIONS[field].prompt,
  }));
}

/** Validates local supplied-plan bounds and balanced coverage before persistence. */
export function validateSuppliedPlan(planInput: unknown, activeHypothesisIds: readonly string[]): ResearchPlanDraft {
  const plan = parsePlanDraft(planInput, "suppliedPlan");
  if (plan.queries.length === 0 || plan.queries.length > plan.limits.maxQueries) invalid("suppliedPlan.queries", "out_of_range");
  const active = new Set(activeHypothesisIds);
  for (const [index, query] of plan.queries.entries()) {
    for (const id of query.hypothesisIds) {
      if (!active.has(id)) invalid(`suppliedPlan.queries[${index}].hypothesisIds`, "invalid_value");
    }
  }
  for (const hypothesisId of active) {
    const queries = plan.queries.filter((query) => query.hypothesisIds.includes(hypothesisId));
    if (!queries.some((query) => query.evidenceIntent === "supporting")) invalid("suppliedPlan.queries", "inconsistent");
    if (!queries.some((query) => query.evidenceIntent === "challenging")) invalid("suppliedPlan.queries", "inconsistent");
  }
  return plan;
}

export function writeOperationForTool(name: ResearchToolName): WriteOperation | null {
  switch (name) {
    case "research_case_create": return name;
    case "research_case_update": return name;
    case "research_plan": return name;
    case "research_start": return name;
    case "research_cancel": return name;
    default: return null;
  }
}
