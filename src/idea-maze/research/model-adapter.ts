import {
  generateTaskJson,
  getTaskJsonInputTokenUpperBound,
  getLlmProviderAvailability,
  getConfiguredProvider,
  type LlmTaskJsonRequest,
} from "../scripts/lib/llm.js";
import type { ProviderBinding, ModelProvider } from "./ports.js";

export interface RegisteredModelBindingOptions {
  environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Bind the provider-neutral task router to the research model port. Authentication,
 * request formatting, model defaults, input-budget admission, and cancellation
 * remain inside the registered adapter boundary.
 */
export function createRegisteredModelBinding(
  options: RegisteredModelBindingOptions = {},
): ProviderBinding<ModelProvider> {
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const availability = getLlmProviderAvailability(environment);
  if (availability !== "available") return { availability, adapter: null, provider: null };

  const configuredProvider = getConfiguredProvider(environment);
  if (!configuredProvider) return { availability: "not_configured", adapter: null, provider: null };

  const provider: ModelProvider = Object.freeze({
    inputTokenUpperBound(request) {
      return getTaskJsonInputTokenUpperBound({
        task: request.task,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        maxOutputTokens: request.maxOutputTokens,
        environment,
      });
    },
    async generateJson<T>(request: LlmTaskJsonRequest): Promise<{
      value: T;
      usage: { inputTokens: null; outputTokens: null; costMicros: null };
    }> {
      const response = await generateTaskJson<T>({
        task: request.task,
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        maxInputTokens: request.maxInputTokens,
        maxOutputTokens: request.maxOutputTokens,
        signal: request.signal,
        environment,
      });
      return response;
    },
  });

  return Object.freeze({
    availability: "available",
    // Keep public capability labels generic even when an adapter registration
    // name contains implementation details.
    adapter: "registered-task-model",
    provider,
  });
}
