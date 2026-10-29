import { describe, expect, it } from "vitest";
import {
  RESEARCH_SCHEMA_VERSION,
  type ResearchFailure,
} from "./contracts.js";
import {
  ContractValidationError,
  getMissingIntakeFields,
  validateSuppliedPlan,
  validateToolInput,
  validationFailure,
} from "./validation.js";
import { buildSyntheticResearchExample, SYNTHETIC_SOURCE_TEXT } from "./example.js";
import { RESEARCH_TOOL_DEFINITIONS, getResearchToolDefinition, type JsonSchema } from "./tools.js";
import { verifyEvidenceExcerpt } from "../scripts/lib/evidence-excerpts.js";

function referencedSchema(schema: JsonSchema, root: JsonSchema): JsonSchema | null {
  if (!schema.$ref) return schema;
  const match = schema.$ref.match(/^#\/\$defs\/([A-Za-z0-9_]+)$/u);
  if (!match) return null;
  return root.$defs?.[match[1]] ?? null;
}

/** A small test-only subset sufficient for the emitted contract schemas. */
function matchesSchema(value: unknown, inputSchema: JsonSchema, root: JsonSchema): boolean {
  const schema = referencedSchema(inputSchema, root);
  if (!schema) return false;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value as never)) return false;
  if (schema.oneOf && schema.oneOf.filter((choice) => matchesSchema(value, choice, root)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some((choice) => matchesSchema(value, choice, root))) return false;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const typeMatches = types.some((type) => {
      if (type === "null") return value === null;
      if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
      if (type === "array") return Array.isArray(value);
      if (type === "integer") return typeof value === "number" && Number.isInteger(value);
      if (type === "number") return typeof value === "number";
      if (type === "boolean") return typeof value === "boolean";
      return type === "string" && typeof value === "string";
    });
    if (!typeMatches) return false;
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return false;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return false;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
    if (schema.items && !value.every((item) => matchesSchema(item, schema.items!, root))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.minProperties !== undefined && Object.keys(record).length < schema.minProperties) return false;
    if (schema.required?.some((key) => !Object.prototype.hasOwnProperty.call(record, key))) return false;
    if (schema.additionalProperties === false && Object.keys(record).some((key) => !schema.properties || !(key in schema.properties))) return false;
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(record, key) && !matchesSchema(record[key], propertySchema, root)) return false;
    }
  }
  return true;
}

function expectValidationError(action: () => unknown): ContractValidationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractValidationError);
    return error as ContractValidationError;
  }
  throw new Error("Expected contract validation to fail.");
}

describe("hypothesis research contracts", () => {
  it("keeps the nine agreed tool names and requires closed object schemas", () => {
    expect(RESEARCH_TOOL_DEFINITIONS.map((definition) => definition.name)).toEqual([
      "research_capabilities",
      "research_case_create",
      "research_case_get",
      "research_case_update",
      "research_plan",
      "research_start",
      "research_status",
      "research_result",
      "research_cancel",
    ]);
    for (const definition of RESEARCH_TOOL_DEFINITIONS) {
      expect(definition.inputSchema.type).toBe("object");
      expect(definition.inputSchema.additionalProperties).toBe(false);
      expect(definition.outputSchema.type).toBe("object");
      expect(definition.outputSchema.oneOf).toHaveLength(2);
      expect(definition.outputSchema.$defs).toBeDefined();
      expect(definition.annotations).toHaveProperty("openWorldHint");
      expect(definition.annotations).toHaveProperty("idempotentHint");
    }
  });

  it("reports all absent intake fields and distinguishes planning blockers", () => {
    const missing = getMissingIntakeFields({}, 0);
    expect(missing.map((item) => item.field)).toEqual([
      "ideaSummary", "targetUser", "problem", "proposedSolution", "currentAlternatives",
      "usageFrequency", "budgetOrWillingnessToPay", "decisionMaker", "constraints", "hypotheses",
    ]);
    expect(missing.filter((item) => item.blockingForPlanning).map((item) => item.field)).toEqual([
      "ideaSummary", "targetUser", "problem", "proposedSolution", "hypotheses",
    ]);
    expect(getMissingIntakeFields({ currentAlternatives: [], constraints: [] }, 1)
      .map((item) => item.field)).not.toContain("currentAlternatives");
  });

  it("rejects missing idempotency keys, oversized values, and unknown keys without echoing them", () => {
    expectValidationError(() => validateToolInput("research_case_create", { intake: {} }));
    const longPrivateKey = `private-${"x".repeat(500)}`;
    const error = expectValidationError(() => validateToolInput("research_case_create", {
      idempotencyKey: "example-case-create-0001",
      [longPrivateKey]: "never reflect this key",
    }));
    expect(error.issues[0]).toEqual({ path: "*", code: "unknown_key" });
    const failure = validationFailure(error) as ResearchFailure;
    expect(JSON.stringify(failure)).not.toContain(longPrivateKey);
    expect(failure.error.details.kind).toBe("validation");

    expectValidationError(() => validateToolInput("research_result", { runId: "run_example", limit: 101 }));
    expectValidationError(() => validateToolInput("research_case_create", {
      idempotencyKey: "example-case-create-0001",
      intake: { ideaSummary: "valid", unrecognized: "value" },
    }));
  });

  it("preserves accepted suggestion provenance and supports immutable historical reads", () => {
    const accepted = validateToolInput("research_case_update", {
      idempotencyKey: "example-case-update-0001",
      caseId: "case_example",
      expectedRevision: 2,
      hypothesisMutations: [{
        operation: "add",
        clientRef: "claim_one",
        claim: "A sufficiently long synthetic claim.",
        origin: "model_suggested",
        sourceSuggestionId: "suggestion_example",
      }],
    });
    expect(accepted.hypothesisMutations?.[0]).toMatchObject({ origin: "model_suggested", sourceSuggestionId: "suggestion_example" });
    expect(validateToolInput("research_case_get", { caseId: "case_example", revision: 1 }).revision).toBe(1);
    expectValidationError(() => validateToolInput("research_case_update", {
      idempotencyKey: "example-case-update-0001",
      caseId: "case_example",
      expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      intakePatch: { targetUser: "A user" },
    }));
  });

  it("requires a bounded plan with supporting and challenging coverage for every active claim", () => {
    const balancedPlan = {
      queries: [
        { text: "support query", purpose: "problem_language", evidenceIntent: "supporting", hypothesisIds: ["hypothesis_one"], sourceScopes: ["public_web"] },
        { text: "challenge query", purpose: "counterevidence", evidenceIntent: "challenging", hypothesisIds: ["hypothesis_one"], sourceScopes: ["public_reddit"] },
      ],
      limits: { maxQueries: 2, maxFetchedPages: 5, maxFollowUpRounds: 1, maxWallTimeSeconds: 120, maxModelInputTokens: 3000, maxModelOutputTokens: 1000 },
    };
    expect(validateSuppliedPlan(balancedPlan, ["hypothesis_one"]).queries).toHaveLength(2);
    expectValidationError(() => validateSuppliedPlan({
      ...balancedPlan,
      queries: [balancedPlan.queries[0]],
      limits: { ...balancedPlan.limits, maxQueries: 1 },
    }, ["hypothesis_one"]));
    expectValidationError(() => validateSuppliedPlan({
      ...balancedPlan,
      limits: { ...balancedPlan.limits, maxFetchedPages: 1000 },
    }, ["hypothesis_one"]));
  });

  it("validates the complete synthetic flow against both runtime inputs and emitted schemas", () => {
    const example = buildSyntheticResearchExample();
    expect(example.calls.length).toBeGreaterThan(9);
    for (const call of example.calls) {
      const definition = getResearchToolDefinition(call.toolName);
      expect(definition).toBeDefined();
      expect(() => validateToolInput(call.toolName, call.input)).not.toThrow();
      expect(matchesSchema(call.input, definition!.inputSchema, definition!.inputSchema)).toBe(true);
      expect(matchesSchema(call.response, definition!.outputSchema, definition!.outputSchema)).toBe(true);
    }

    const completed = example.calls.find((call) => call.toolName === "research_status");
    expect(completed?.toolName).toBe("research_status");
    if (completed?.toolName === "research_status" && "data" in completed.response) {
      expect(completed.response.data.status).toBe("completed");
      expect(completed.response.data.stoppingReason).toBe("all_steps_finished");
    }
    const pages = example.calls.filter((call) => call.toolName === "research_result");
    expect(pages).toHaveLength(2);
    const firstPage = pages[0];
    if (firstPage.toolName === "research_result" && "data" in firstPage.response) {
      expect(firstPage.response.data.assessment?.outcome).toBe("insufficient_evidence");
      const excerpt = firstPage.response.data.evidence[0];
      expect(excerpt.kind).toBe("verified_excerpt");
      if (excerpt.kind === "verified_excerpt") {
        expect(excerpt.excerpt.sourceTextHash).toMatch(/^[a-f0-9]{64}$/u);
        expect(excerpt.excerpt.endUtf16).toBeGreaterThan(excerpt.excerpt.startUtf16);
        expect(verifyEvidenceExcerpt({ sourceItemId: 42, sourceText: SYNTHETIC_SOURCE_TEXT, excerpt: excerpt.excerpt })).toEqual(excerpt.excerpt);
      }
      expect(firstPage.response.data.pagination.hasMore).toBe(true);
    }
    expect(pages[1]?.toolName).toBe("research_result");
    if (pages[1]?.toolName === "research_result" && "data" in pages[1].response) {
      expect(pages[1].response.data.evidence[0]?.kind).toBe("search_snippet");
      expect(pages[1].response.data.pagination.nextCursor).toBeNull();
    }
  });

  it("uses one versioned envelope for success and typed errors", () => {
    const example = buildSyntheticResearchExample();
    expect(example.calls.every((call) => call.response.schemaVersion === RESEARCH_SCHEMA_VERSION)).toBe(true);
    const missingPlan: ResearchFailure = {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      error: {
        code: "NOT_FOUND",
        message: "The plan was not found.",
        retryable: false,
        details: { kind: "not_found", resource: "plan", id: "plan_missing" },
      },
    };
    const start = getResearchToolDefinition("research_start")!;
    expect(matchesSchema(missingPlan, start.outputSchema, start.outputSchema)).toBe(true);
  });
});
