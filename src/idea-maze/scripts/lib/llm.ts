/**
 * Minimal LLM API client.
 *
 * Uses Anthropic when ANTHROPIC_API_KEY is available. Falls back to OpenAI
 * when OPENAI_API_KEY is available. Falls back gracefully when no provider key
 * is available.
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

export const EXTRACTION_MODEL = "claude-haiku-4-5-20251001"; // fast + cheap for bulk extraction
export const RESEARCH_MODEL = "claude-sonnet-4-6"; // full reasoning for research drafts
const OPENAI_EXTRACTION_MODEL = "gpt-5-mini";
const OPENAI_RESEARCH_MODEL = "gpt-5.1";
const RESEARCH_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

type LlmProvider = "anthropic" | "openai";

class LlmApiError extends Error {
  constructor(
    message: string,
    readonly provider: LlmProvider,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "LlmApiError";
  }
}

export function getConfiguredProvider(): LlmProvider | null {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

export function isLlmConfigured(): boolean {
  return getConfiguredProvider() !== null;
}

export function getMissingLlmReason(): string {
  return "No configured LLM provider (set ANTHROPIC_API_KEY or OPENAI_API_KEY)";
}

function modelFor(provider: LlmProvider, anthropicModel: string): string {
  if (provider === "anthropic") return anthropicModel;
  if (anthropicModel === RESEARCH_MODEL) {
    return process.env.OPENAI_RESEARCH_MODEL ?? OPENAI_RESEARCH_MODEL;
  }
  return process.env.OPENAI_EXTRACTION_MODEL ?? OPENAI_EXTRACTION_MODEL;
}

export function getExtractionModel(): string | null {
  const provider = getConfiguredProvider();
  return provider ? modelFor(provider, EXTRACTION_MODEL) : null;
}

export function getResearchModel(): string | null {
  const provider = getConfiguredProvider();
  return provider ? modelFor(provider, RESEARCH_MODEL) : null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function providerLabel(provider: LlmProvider): string {
  return provider === "anthropic" ? "Anthropic" : "OpenAI";
}

function extractJson<T>(text: string): T {
  const jsonMatch =
    text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in LLM response: ${text.slice(0, 200)}`);
  }

  return JSON.parse(jsonMatch[1].trim()) as T;
}

async function callAnthropicApi<T>(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<T> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new LlmApiError(
      `Anthropic API ${res.status}: ${body}`,
      "anthropic",
      res.status,
      body,
    );
  }

  const data = (await res.json()) as any;
  const text: string = data.content?.[0]?.text ?? "";
  return extractJson<T>(text);
}

async function callOpenAiApi<T>(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<T> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const res = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: maxTokens,
    }),
    signal,
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
}

function isRetryableApiError(error: unknown): error is LlmApiError {
  return (
    error instanceof LlmApiError &&
    (error.status === 429 || error.status >= 500)
  );
}

async function callApi<T>(
  anthropicModel: string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 4096,
  timeoutMs?: number,
): Promise<T> {
  const provider = getConfiguredProvider();
  if (!provider) throw new Error(getMissingLlmReason());

  const controller = timeoutMs ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const model = modelFor(provider, anthropicModel);

  try {
    if (provider === "anthropic") {
      try {
        return await callAnthropicApi<T>(
          model,
          systemPrompt,
          userPrompt,
          maxTokens,
          controller?.signal,
        );
      } catch (err) {
        if (process.env.OPENAI_API_KEY && isRetryableApiError(err)) {
          return await callOpenAiApi<T>(
            modelFor("openai", anthropicModel),
            systemPrompt,
            userPrompt,
            maxTokens,
            controller?.signal,
          );
        }
        throw err;
      }
    }
    return await callOpenAiApi<T>(
      model,
      systemPrompt,
      userPrompt,
      maxTokens,
      controller?.signal,
    );
  } catch (err) {
    if (timeoutMs && isAbortError(err)) {
      throw new Error(
        `${providerLabel(provider)} API request timed out after ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/** Single-item extraction using the configured extraction model */
export async function generateJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>(EXTRACTION_MODEL, systemPrompt, userPrompt);
}

/** Research drafting using the configured research model */
export async function generateResearchJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>(
    RESEARCH_MODEL,
    systemPrompt,
    userPrompt,
    8192,
    RESEARCH_REQUEST_TIMEOUT_MS,
  );
}

/** Batch extraction: sends up to BATCH_SIZE items in one extraction-model call */
export const EXTRACTION_BATCH_SIZE = 8;

export async function generateBatchJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>(EXTRACTION_MODEL, systemPrompt, userPrompt, 8192);
}
