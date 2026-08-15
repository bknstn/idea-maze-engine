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
}

export interface LlmProviderAdapter {
  readonly displayName: string;
  readonly name: string;
  generateJson<T>(request: LlmRequest): Promise<T>;
  isConfigured(): boolean;
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
  isConfigured: () => Boolean(process.env.OPENAI_API_KEY),
  async generateJson<T>(request: LlmRequest): Promise<T> {
    const apiKey = process.env.OPENAI_API_KEY;
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

function selectedProviderName(): string {
  return process.env.IDEA_MAZE_LLM_PROVIDER?.trim() || "openai";
}

function selectedProvider(): LlmProviderAdapter | null {
  return providerRegistry.get(selectedProviderName()) ?? null;
}

export function getConfiguredProvider(): string | null {
  const provider = selectedProvider();
  return provider?.isConfigured() ? provider.name : null;
}

export function isLlmConfigured(): boolean {
  return getConfiguredProvider() !== null;
}

export function getMissingLlmReason(): string {
  const providerName = selectedProviderName();
  const provider = selectedProvider();
  if (!provider) {
    return `LLM provider "${providerName}" is not registered`;
  }
  return `LLM provider "${providerName}" is not configured`;
}

export function getModel(task: LlmTask): string {
  return process.env[MODEL_ENV[task]]?.trim() || DEFAULT_MODELS[task];
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
  if (!provider?.isConfigured()) throw new Error(getMissingLlmReason());

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
