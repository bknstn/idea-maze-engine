/**
 * MCP protocol registration for hypothesis research.
 *
 * This module is deliberately an adapter over an injected application. It has
 * no workspace, database, provider, or process-global defaults.
 */

import {
  McpServer,
  fromJsonSchema,
  type JsonSchemaType,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";

import {
  RESEARCH_SCHEMA_VERSION,
  type ResearchApplication,
  type ResearchErrorDetails,
  type ResearchFailure,
  type ResearchResponse,
  type ToolDataMap,
  type ToolInputMap,
} from "../research/contracts.js";
import { ContractValidationError, validateToolInput, validationFailure } from "../research/validation.js";
import {
  RESEARCH_TOOL_DEFINITIONS,
  type ResearchToolName,
} from "../research/tools.js";

/** Upper bound applied to adapter-generated CallToolResult JSON, including both output forms. */
export const MAX_MCP_TOOL_RESULT_BYTES = 512 * 1024;

const INTERNAL_ERROR_DETAILS: ResearchErrorDetails = { kind: "internal" };
const RESEARCH_ERROR_CODES = new Set([
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "BUSY",
  "PROVIDER_UNAVAILABLE",
  "LIMIT_EXCEEDED",
  "RUN_NOT_CANCELLABLE",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);

function internalFailure(): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: {
      code: "INTERNAL_ERROR",
      message: "The research request could not be completed.",
      // A lost response may follow already submitted provider work. Do not
      // encourage automatic retries when the outcome is unknown.
      retryable: false,
      details: INTERNAL_ERROR_DETAILS,
    },
  };
}

/**
 * Validate again at the application boundary, even though the SDK also
 * validates its advertised JSON Schema. This keeps application dispatch safe
 * if the tool is called through another protocol surface in the future.
 */
async function invokeResearchTool(
  app: ResearchApplication,
  name: ResearchToolName,
  rawInput: unknown,
): Promise<ResearchResponse<unknown>> {
  let response: unknown;
  try {
    response = await dispatchResearchTool(app, name, rawInput);
  } catch (error) {
    response = error instanceof ContractValidationError ? validationFailure(error) : internalFailure();
  }
  return isResearchResponseEnvelope(response) ? response : internalFailure();
}

async function dispatchResearchTool(
  app: ResearchApplication,
  name: ResearchToolName,
  rawInput: unknown,
): Promise<ResearchResponse<unknown>> {
  switch (name) {
    case "research_capabilities":
      validateToolInput(name, rawInput);
      return app.capabilities();
    case "research_case_create":
      return app.createCase(validateToolInput(name, rawInput));
    case "research_case_get":
      return app.getCase(validateToolInput(name, rawInput));
    case "research_case_update":
      return app.updateCase(validateToolInput(name, rawInput));
    case "research_plan":
      return app.plan(validateToolInput(name, rawInput));
    case "research_start":
      return app.start(validateToolInput(name, rawInput));
    case "research_status":
      return app.status(validateToolInput(name, rawInput));
    case "research_result":
      return app.result(validateToolInput(name, rawInput));
    case "research_cancel":
      return app.cancel(validateToolInput(name, rawInput));
    default: {
      const exhaustive: never = name;
      return exhaustive;
    }
  }
}

function toMcpResult(response: ResearchResponse<unknown>) {
  try {
    return encodeMcpResult(response);
  } catch {
    // The fallback is a small, plain, schema-valid envelope.
    return encodeMcpResult(internalFailure());
  }
}

function encodeMcpResult(response: ResearchResponse<unknown>) {
  const encodedResponse = JSON.stringify(response);
  if (typeof encodedResponse !== "string") throw new TypeError("Tool output is not JSON serializable.");
  const structuredContent: unknown = JSON.parse(encodedResponse);
  const isError = isRecord(structuredContent) && Object.prototype.hasOwnProperty.call(structuredContent, "error");
  const result = {
    content: [{ type: "text" as const, text: encodedResponse }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
  const encodedResult = JSON.stringify(result);
  if (Buffer.byteLength(encodedResult, "utf8") > MAX_MCP_TOOL_RESULT_BYTES) {
    throw new RangeError("MCP tool result exceeds the configured byte bound.");
  }
  return result;
}

function isResearchResponseEnvelope(value: unknown): value is ResearchResponse<unknown> {
  if (!isRecord(value) || value.schemaVersion !== RESEARCH_SCHEMA_VERSION) return false;
  const hasData = Object.prototype.hasOwnProperty.call(value, "data");
  const hasError = Object.prototype.hasOwnProperty.call(value, "error");
  if (hasData === hasError) return false;
  if (hasData) return true;
  const error = value.error;
  return isRecord(error) &&
    typeof error.code === "string" && RESEARCH_ERROR_CODES.has(error.code) &&
    typeof error.message === "string" && error.message.length > 0 && error.message.length <= 512 &&
    typeof error.retryable === "boolean" && isRecord(error.details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Copy method references and bind `this` once, so later mutation of an injected app cannot redirect dispatch. */
export function snapshotResearchApplication(app: ResearchApplication): ResearchApplication {
  if (app === null || typeof app !== "object" || Array.isArray(app)) {
    throw new TypeError("a research application object is required");
  }
  const methods = ["capabilities", "createCase", "getCase", "updateCase", "plan", "start", "status", "result", "cancel"] as const;
  for (const method of methods) {
    if (typeof app[method] !== "function") throw new TypeError("all research application methods are required");
  }
  return Object.freeze({
    capabilities: app.capabilities.bind(app),
    createCase: app.createCase.bind(app),
    getCase: app.getCase.bind(app),
    updateCase: app.updateCase.bind(app),
    plan: app.plan.bind(app),
    start: app.start.bind(app),
    status: app.status.bind(app),
    result: app.result.bind(app),
    cancel: app.cancel.bind(app),
  });
}

/** Create a fresh SDK server whose handlers all close over the same app. */
export function createResearchMcpServer(app: ResearchApplication): McpServer {
  const stableApp = snapshotResearchApplication(app);
  const server = new McpServer({
    name: "idea-maze-hypothesis-research",
    version: RESEARCH_SCHEMA_VERSION,
  });

  for (const definition of RESEARCH_TOOL_DEFINITIONS) {
    const name = definition.name as ResearchToolName;
    const outputSchema = fromJsonSchema<ResearchResponse<ToolDataMap[typeof name]>>(
      definition.outputSchema as JsonSchemaType,
    );
    server.registerTool(
      name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: fromJsonSchema<ToolInputMap[typeof name]>(definition.inputSchema as JsonSchemaType),
        outputSchema,
        annotations: definition.annotations as ToolAnnotations,
      },
      async (input) => {
        let response: ResearchResponse<unknown>;
        try {
          response = await invokeResearchTool(stableApp, name, input);
          const validation = await outputSchema["~standard"].validate(response);
          response = "issues" in validation ? internalFailure() : validation.value;
        } catch {
          response = internalFailure();
        }
        return toMcpResult(response);
      },
    );
  }

  return server;
}
