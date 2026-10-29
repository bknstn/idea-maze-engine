/**
 * Provider-neutral LLM orchestration.
 *
 * Pipeline stages select a task, never a vendor model. Each provider adapter
 * owns its authentication, request, and response formats. Models remain
 * independently configurable for extraction, research, and exploration.
 */

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const RESEARCH_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

export type LlmTask = "extraction" | "research" | "exploration";

export interface LlmRequest {
  maxTokens: number;
  model: string;
  signal?: AbortSignal;
  systemPrompt: string;
  task: LlmTask;
  userPrompt: string;
  /** Explicit environment passed by a host factory; provider adapters own its meaning. */
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface LlmProviderAdapter {
  readonly displayName: string;
  readonly name: string;
  /** Required by explicit runtime bindings; legacy adapters remain usable by legacy wrappers. */
  readonly environmentAware?: true;
  /** Conservative admission bound for prompt tokens; null/absence means unsupported. */
  inputTokenUpperBound?(request: LlmRequest): number | null;
  generateJson<T>(request: LlmRequest): Promise<T>;
  isConfigured(environment?: Readonly<Record<string, string | undefined>>): boolean;
}

export interface LlmTaskJsonRequest {
  task: LlmTask;
  systemPrompt: string;
  userPrompt: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  signal: AbortSignal;
  environment?: Readonly<Record<string, string | undefined>>;
}

export type LlmTaskJsonInputRequest = Pick<LlmTaskJsonRequest,
  "task" | "systemPrompt" | "userPrompt" | "maxOutputTokens" | "environment">;

export interface LlmTaskJsonUsage {
  inputTokens: null;
  outputTokens: null;
  costMicros: null;
}

export interface LlmTaskJsonResponse<T> {
  value: T;
  usage: LlmTaskJsonUsage;
}

export class LlmInputBudgetError extends Error {
  constructor(readonly reason: "unsupported" | "exceeded") {
    super(reason === "unsupported"
      ? "The configured model adapter cannot enforce an input-token budget."
      : "The model prompt exceeds the configured input-token budget.");
    this.name = "LlmInputBudgetError";
  }
}

export class LlmEnvironmentBindingError extends Error {
  constructor() {
    super("The configured model adapter cannot honor an explicit runtime environment.");
    this.name = "LlmEnvironmentBindingError";
  }
}

const DEFAULT_MODELS: Record<LlmTask, string> = {
  extraction: "gpt-5.6-luna",
  research: "gpt-5.6-terra",
  exploration: "gpt-5.6-sol",
};

const MODEL_ENV: Record<LlmTask, string> = {
  extraction: "IDEA_MAZE_EXTRACTION_MODEL",
  research: "IDEA_MAZE_RESEARCH_MODEL",
  exploration: "IDEA_MAZE_EXPLORATION_MODEL",
};

class LlmApiError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "LlmApiError";
  }
}

function extractJson<T>(text: string): T {
  const jsonMatch =
    text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in LLM response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(jsonMatch[1].trim()) as T;
}

const openAiProvider: LlmProviderAdapter = {
  name: "openai",
  displayName: "OpenAI",
  environmentAware: true,
  isConfigured: (environment = process.env) => Boolean(environment.OPENAI_API_KEY),
  inputTokenUpperBound: (request) => openAiInputTokenUpperBound(request),
  async generateJson<T>(request: LlmRequest): Promise<T> {
    const apiKey = request.environment === undefined
      ? process.env.OPENAI_API_KEY
      : request.environment.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY not set");

    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
        max_completion_tokens: request.maxTokens,
        response_format: { type: "json_object" },
      }),
      signal: request.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new LlmApiError(
        `OpenAI API ${res.status}: ${body}`,
        "openai",
        res.status,
        body,
      );
    }

    const data = (await res.json()) as any;
    const text: string = data.choices?.[0]?.message?.content ?? "";
    return extractJson<T>(text);
  },
};

const providerRegistry = new Map<string, LlmProviderAdapter>();

export function registerLlmProvider(adapter: LlmProviderAdapter): void {
  providerRegistry.set(adapter.name, adapter);
}

registerLlmProvider(openAiProvider);

function selectedProviderName(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  return environment.IDEA_MAZE_LLM_PROVIDER?.trim() || "openai";
}

function selectedProvider(environment: Readonly<Record<string, string | undefined>> = process.env): LlmProviderAdapter | null {
  return providerRegistry.get(selectedProviderName(environment)) ?? null;
}

export function getConfiguredProvider(environment?: Readonly<Record<string, string | undefined>>): string | null {
  const effectiveEnvironment = environment ?? process.env;
  const provider = selectedProvider(effectiveEnvironment);
  if (environment !== undefined && provider?.environmentAware !== true) return null;
  return provider?.isConfigured(effectiveEnvironment) ? provider.name : null;
}

export function getLlmProviderAvailability(
  environment?: Readonly<Record<string, string | undefined>>,
): "available" | "not_configured" | "unavailable" {
  const effectiveEnvironment = environment ?? process.env;
  const provider = selectedProvider(effectiveEnvironment);
  if (!provider) return "unavailable";
  if (environment !== undefined && provider.environmentAware !== true) return "unavailable";
  return provider.isConfigured(effectiveEnvironment) ? "available" : "not_configured";
}

/** Ask the selected registered adapter to bound this exact task prompt without dispatching it. */
export function getTaskJsonInputTokenUpperBound(request: LlmTaskJsonInputRequest): number | null {
  if (!request || typeof request !== "object" ||
      !["extraction", "research", "exploration"].includes(request.task) ||
      typeof request.systemPrompt !== "string" || typeof request.userPrompt !== "string" ||
      !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1) return null;
  const environment = request.environment ?? process.env;
  const provider = selectedProvider(environment);
  if (!provider?.isConfigured(environment) ||
      (request.environment !== undefined && provider.environmentAware !== true)) return null;
  const providerRequest: LlmRequest = {
    task: request.task,
    model: getModel(request.task, environment),
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    maxTokens: request.maxOutputTokens,
    environment,
  };
  const upperBound = provider.inputTokenUpperBound?.(providerRequest);
  return Number.isSafeInteger(upperBound) && (upperBound as number) >= 0 ? upperBound as number : null;
}

export function isLlmConfigured(): boolean {
  return getConfiguredProvider() !== null;
}

export function getMissingLlmReason(environment: Readonly<Record<string, string | undefined>> = process.env): string {
  const providerName = selectedProviderName(environment);
  const provider = selectedProvider(environment);
  if (!provider) {
    return `LLM provider "${providerName}" is not registered`;
  }
  return `LLM provider "${providerName}" is not configured`;
}

export function getModel(task: LlmTask, environment: Readonly<Record<string, string | undefined>> = process.env): string {
  return environment[MODEL_ENV[task]]?.trim() || DEFAULT_MODELS[task];
}

export function getExtractionModel(): string | null {
  return isLlmConfigured() ? getModel("extraction") : null;
}

export function getResearchModel(): string | null {
  return isLlmConfigured() ? getModel("research") : null;
}

export function getExplorationModel(): string | null {
  return isLlmConfigured() ? getModel("exploration") : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function callApi<T>(
  task: LlmTask,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4096,
  timeoutMs?: number,
): Promise<T> {
  const provider = selectedProvider();
  if (!provider?.isConfigured(process.env)) throw new Error(getMissingLlmReason());

  const controller = timeoutMs ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    return await provider.generateJson<T>({
      task,
      model: getModel(task),
      systemPrompt,
      userPrompt,
      maxTokens,
      signal: controller?.signal,
    });
  } catch (err) {
    if (timeoutMs && isAbortError(err)) {
      throw new Error(
        `${provider.displayName} API request timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Provider-neutral bounded task routing for research services. It preserves
 * the task-specific model defaults and registered adapter boundary, propagates
 * the service-owned signal, and refuses dispatch unless the selected adapter
 * can admit the prompt beneath the supplied input-token ceiling. Providers do
 * not currently expose observed usage through the legacy adapter interface, so
 * all usage fields remain unknown rather than being estimated.
 */
export async function generateTaskJson<T>(request: LlmTaskJsonRequest): Promise<LlmTaskJsonResponse<T>> {
  if (!request || typeof request !== "object" ||
      !["extraction", "research", "exploration"].includes(request.task) ||
      typeof request.systemPrompt !== "string" || typeof request.userPrompt !== "string" ||
      !Number.isSafeInteger(request.maxInputTokens) || request.maxInputTokens < 1 ||
      !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 ||
      !request.signal || typeof request.signal.aborted !== "boolean") {
    throw new TypeError("A bounded task request with prompts, token limits, and signal is required");
  }
  if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");

  const hasExplicitEnvironment = request.environment !== undefined;
  const environment = request.environment ?? process.env;
  const provider = selectedProvider(environment);
  if (!provider?.isConfigured(environment)) throw new Error(getMissingLlmReason(environment));
  if (hasExplicitEnvironment && provider.environmentAware !== true) throw new LlmEnvironmentBindingError();

  const inputBoundRequest = {
    task: request.task,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    maxOutputTokens: request.maxOutputTokens,
    ...(request.environment === undefined ? {} : { environment: request.environment }),
  };
  const upperBound = getTaskJsonInputTokenUpperBound(inputBoundRequest);
  if (upperBound === null) {
    throw new LlmInputBudgetError("unsupported");
  }
  if (upperBound > request.maxInputTokens) throw new LlmInputBudgetError("exceeded");
  if (request.signal.aborted) throw request.signal.reason ?? new DOMException("Aborted", "AbortError");

  const providerRequest: LlmRequest = {
    task: request.task,
    model: getModel(request.task, environment),
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    maxTokens: request.maxOutputTokens,
    signal: request.signal,
    ...(request.environment === undefined ? {} : { environment }),
  };
  const value = await provider.generateJson<T>(providerRequest);
  return {
    value,
    usage: { inputTokens: null, outputTokens: null, costMicros: null },
  };
}

/**
 * In the standard two-message JSON request shape, each prompt's byte sequence
 * is an upper bound on its byte-level BPE token count. Add a deliberately large
 * fixed allowance for message framing and the assistant prefix. This provider
 * adapter must revisit the allowance if it adds message metadata, tools, or a
 * different request shape; unknown API usage remains unreported.
 */
function openAiInputTokenUpperBound(request: LlmRequest): number {
  const promptEnvelope = JSON.stringify([
    { role: "system", content: request.systemPrompt },
    { role: "user", content: request.userPrompt },
  ]);
  const promptBytes = Buffer.byteLength(promptEnvelope, "utf8");
  const messageFramingAllowance = 1_024;
  const bound = promptBytes + messageFramingAllowance;
  return Number.isSafeInteger(bound) ? bound : Number.MAX_SAFE_INTEGER;
}

/** Single-item extraction using the configured extraction model. */
export async function generateJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>("extraction", systemPrompt, userPrompt);
}

/** Cheap structured source-to-thesis classification. */
export async function generateEvidenceAlignmentJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>(
    "extraction",
    systemPrompt,
    userPrompt,
    4096,
    RESEARCH_REQUEST_TIMEOUT_MS,
  );
}

/** Research drafting using the configured research model. */
export async function generateResearchJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>(
    "research",
    systemPrompt,
    userPrompt,
    8192,
    RESEARCH_REQUEST_TIMEOUT_MS,
  );
}

/** Exploration brief generation using the configured exploration model. */
export async function generateExplorationJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>(
    "exploration",
    systemPrompt,
    userPrompt,
    8192,
    RESEARCH_REQUEST_TIMEOUT_MS,
  );
}

/** Batch extraction: sends up to BATCH_SIZE items in one extraction-model call. */
export const EXTRACTION_BATCH_SIZE = 8;

export async function generateBatchJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>("extraction", systemPrompt, userPrompt, 8192);
}
