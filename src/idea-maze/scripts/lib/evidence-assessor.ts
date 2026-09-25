import { createHash } from "node:crypto";

export interface EvidenceAssessmentQuestion {
  id: string;
  dimension: string;
  instructions: string;
  trueMeans: string;
  falseMeans: string;
}

export interface EvidenceAssessmentCandidate {
  candidateId: string;
  state: unknown;
  rubricVersion: string;
  questions: EvidenceAssessmentQuestion[];
}

export interface EvidenceAssessmentBudget {
  maxCalls?: number;
  maxInputTokens?: number;
  timeoutMs?: number;
}

export interface AssessmentPlanEntry {
  candidate: EvidenceAssessmentCandidate;
  cacheKey: string | null;
  estimatedInputTokens: number | null;
  status: "ready" | "skipped_budget";
  reason: "call_limit" | "input_token_limit" | "invalid_request" | null;
}

export interface DimensionAssessment {
  id: string;
  dimension: string;
  status: "scored" | "unknown";
  noul: number | null;
}

export type EvidenceAssessmentStatus =
  | "complete"
  | "partial"
  | "unknown"
  | "disabled"
  | "skipped_budget"
  | "error";

export interface EvidenceAssessmentOutcome {
  candidateId: string;
  /** Retained verbatim so an assessment failure never drops or rewrites evidence. */
  candidateState: unknown;
  mode: "shadow";
  appliedToDecision: false;
  status: EvidenceAssessmentStatus;
  cacheHit: boolean;
  reason: string | null;
  requestedModel: string | null;
  returnedModel: string | null;
  cacheKey: string | null;
  rubricVersion: string;
  assessments: DimensionAssessment[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  estimatedInputTokens: number | null;
  latencyMs: number | null;
  httpStatus: number | null;
  retryable: boolean;
}

export interface EvidenceAssessor {
  readonly name: "typesafe-jev";
  isEnabled(): boolean;
  requestedModel(): string | null;
  assessBatch(
    candidates: EvidenceAssessmentCandidate[],
    budget?: EvidenceAssessmentBudget,
  ): Promise<EvidenceAssessmentOutcome[]>;
}

export const DEFAULT_EVIDENCE_ASSESSMENT_BUDGET = Object.freeze({
  maxCalls: 5,
  maxInputTokens: 12_000,
  timeoutMs: 20_000,
});

const MAX_ASSESSMENT_CALLS = 20;
const MAX_ASSESSMENT_INPUT_TOKENS = 100_000;
const MAX_ASSESSMENT_TIMEOUT_MS = 120_000;
const MAX_QUESTIONS_PER_CANDIDATE = 20;

export function stableSerialize(value: unknown): string {
  assertJsonValue(value, new Set());
  return stableSerializeValue(value);
}

function stableSerializeValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("value is not JSON serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(stableSerializeValue).join(",")}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("only plain JSON objects can be serialized");
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerializeValue(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function estimateInputTokens(payload: unknown): number {
  const serialized = stableSerialize(payload);
  // UTF-8 bytes are a deliberately conservative budget proxy, not provider token usage.
  return new TextEncoder().encode(serialized).byteLength;
}

export function buildAssessmentCacheKey(args: {
  state: unknown;
  questions: EvidenceAssessmentQuestion[];
  rubricVersion: string;
  requestedModel: string;
}): string {
  if (!args.requestedModel.trim() || !args.rubricVersion.trim()) {
    throw new TypeError("requestedModel and rubricVersion are required for the cache key");
  }
  if (!(typeof args.state === "string" || Array.isArray(args.state) || isPlainObject(args.state))) {
    throw new TypeError("state root must be a string, object, or array");
  }
  const payload = stableSerialize({
    state: args.state,
    questions: args.questions,
    rubricVersion: args.rubricVersion,
    requestedModel: args.requestedModel,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function planAssessmentBatch(args: {
  candidates: EvidenceAssessmentCandidate[];
  requestedModel: string | null;
  budget?: EvidenceAssessmentBudget;
}): AssessmentPlanEntry[] {
  const budget = validateAssessmentBudget(args.budget ?? {});
  let callCount = 0;
  let inputTokens = 0;
  return args.candidates.map((candidate) => {
    try {
      validateCandidate(candidate);
      if (!args.requestedModel) throw new TypeError("explicit model unavailable");
      const payload = buildRequestBody(candidate, args.requestedModel);
      const estimatedInputTokens = estimateInputTokens(payload);
      const cacheKey = buildAssessmentCacheKey({
        state: candidate.state,
        questions: candidate.questions,
        rubricVersion: candidate.rubricVersion,
        requestedModel: args.requestedModel,
      });
      if (callCount >= budget.maxCalls) {
        return { candidate, cacheKey, estimatedInputTokens, status: "skipped_budget", reason: "call_limit" };
      }
      if (inputTokens + estimatedInputTokens > budget.maxInputTokens) {
        return { candidate, cacheKey, estimatedInputTokens, status: "skipped_budget", reason: "input_token_limit" };
      }
      callCount += 1;
      inputTokens += estimatedInputTokens;
      return { candidate, cacheKey, estimatedInputTokens, status: "ready", reason: null };
    } catch {
      return { candidate, cacheKey: null, estimatedInputTokens: null, status: "skipped_budget", reason: "invalid_request" };
    }
  });
}

export function validateAssessmentBudget(input: EvidenceAssessmentBudget): Required<EvidenceAssessmentBudget> {
  return {
    maxCalls: positiveInt(input.maxCalls ?? DEFAULT_EVIDENCE_ASSESSMENT_BUDGET.maxCalls, "maxCalls", MAX_ASSESSMENT_CALLS),
    maxInputTokens: positiveInt(input.maxInputTokens ?? DEFAULT_EVIDENCE_ASSESSMENT_BUDGET.maxInputTokens, "maxInputTokens", MAX_ASSESSMENT_INPUT_TOKENS),
    timeoutMs: positiveInt(input.timeoutMs ?? DEFAULT_EVIDENCE_ASSESSMENT_BUDGET.timeoutMs, "timeoutMs", MAX_ASSESSMENT_TIMEOUT_MS),
  };
}

export function validateCandidate(candidate: EvidenceAssessmentCandidate): void {
  if (!candidate || typeof candidate.candidateId !== "string" || !candidate.candidateId.trim()) {
    throw new TypeError("candidateId required");
  }
  if (typeof candidate.rubricVersion !== "string" || !candidate.rubricVersion.trim()) {
    throw new TypeError("rubricVersion required");
  }
  if (!Array.isArray(candidate.questions) || candidate.questions.length === 0 || candidate.questions.length > MAX_QUESTIONS_PER_CANDIDATE) {
    throw new TypeError("one to twenty named questions required");
  }
  const seen = new Set<string>();
  for (const question of candidate.questions) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(question.id) || seen.has(question.id)) throw new TypeError("invalid or duplicate question id");
    seen.add(question.id);
    if ([question.dimension, question.instructions, question.trueMeans, question.falseMeans]
      .some((part) => typeof part !== "string" || !part.trim())) {
      throw new TypeError("question dimension, instructions, and criteria are required");
    }
  }
  if (!(typeof candidate.state === "string" || Array.isArray(candidate.state) || isPlainObject(candidate.state))) {
    throw new TypeError("state root must be a string, object, or array");
  }
  assertJsonValue(candidate.state, new Set());
  stableSerialize(candidate.state);
}

export function buildRequestBody(candidate: EvidenceAssessmentCandidate, model: string): Record<string, unknown> {
  return {
    state: candidate.state,
    model,
    questions: Object.fromEntries(candidate.questions.map((question) => [question.id, {
      type: "noul",
      instructions: question.instructions,
      criteria: { true: question.trueMeans, false: question.falseMeans },
    }])),
  };
}

function positiveInt(value: number, name: string, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be a finite integer between 1 and ${maximum}`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite numbers are not valid JSON state");
    return;
  }
  if (typeof value !== "object") throw new TypeError("state contains a non-JSON value");
  if (ancestors.has(value)) throw new TypeError("cyclic state is not valid JSON");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        throw new TypeError("arrays with non-index properties are not valid JSON state");
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("sparse arrays are not valid JSON state");
      assertJsonValue(value[index], ancestors);
    }
  } else {
    if (!isPlainObject(value)) throw new TypeError("only plain JSON objects are valid state");
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError("symbol keys are not valid JSON state");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new TypeError("accessors are not valid JSON state");
      assertJsonValue(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}
