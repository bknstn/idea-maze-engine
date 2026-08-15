import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LlmRequest } from "./llm.ts";

describe("provider-neutral LLM routing", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    process.env.OPENAI_API_KEY = "openai-test-key";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    delete process.env.IDEA_MAZE_LLM_PROVIDER;
    delete process.env.IDEA_MAZE_EXTRACTION_MODEL;
    delete process.env.IDEA_MAZE_RESEARCH_MODEL;
    delete process.env.IDEA_MAZE_EXPLORATION_MODEL;
  });

  it("uses OpenAI by default with task-specific models", async () => {
    vi.useRealTimers();
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const {
      generateBatchJson,
      getConfiguredProvider,
      getExtractionModel,
      getResearchModel,
      isLlmConfigured,
    } = await import("./llm.ts");

    await expect(generateBatchJson("system", "user")).resolves.toEqual({
      ok: true,
    });
    expect(isLlmConfigured()).toBe(true);
    expect(getConfiguredProvider()).toBe("openai");
    expect(getExtractionModel()).toBe("gpt-5.6-luna");
    expect(getResearchModel()).toBe("gpt-5.6-terra");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"model":"gpt-5.6-luna"'),
        headers: expect.objectContaining({
          Authorization: "Bearer openai-test-key",
        }),
      }),
    );
    const request = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.max_completion_tokens).toBe(8192);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("supports independent vendor-neutral model overrides", async () => {
    process.env.IDEA_MAZE_EXTRACTION_MODEL = "extract-model";
    process.env.IDEA_MAZE_RESEARCH_MODEL = "research-model";
    process.env.IDEA_MAZE_EXPLORATION_MODEL = "explore-model";
    const {
      getExtractionModel,
      getResearchModel,
      getExplorationModel,
    } = await import("./llm.ts");

    expect(getExtractionModel()).toBe("extract-model");
    expect(getResearchModel()).toBe("research-model");
    expect(getExplorationModel()).toBe("explore-model");
  });

  it("reports a missing credential without selecting another provider", async () => {
    delete process.env.OPENAI_API_KEY;
    const { getConfiguredProvider, getMissingLlmReason, isLlmConfigured } =
      await import("./llm.ts");

    expect(getConfiguredProvider()).toBeNull();
    expect(isLlmConfigured()).toBe(false);
    expect(getMissingLlmReason()).toBe(
      'LLM provider "openai" is not configured',
    );
  });

  it("allows a different request format through a registered adapter", async () => {
    process.env.IDEA_MAZE_LLM_PROVIDER = "portable-test";
    delete process.env.OPENAI_API_KEY;
    const { generateBatchJson, getConfiguredProvider, registerLlmProvider } =
      await import("./llm.ts");
    const generateJson = vi.fn(async (request: LlmRequest) => ({
      model: request.model,
      task: request.task,
    }));
    registerLlmProvider({
      name: "portable-test",
      displayName: "Portable Test",
      isConfigured: () => true,
      async generateJson<T>(request: LlmRequest): Promise<T> {
        return (await generateJson(request)) as T;
      },
    });

    expect(getConfiguredProvider()).toBe("portable-test");
    await expect(generateBatchJson("system", "user")).resolves.toEqual({
      model: "gpt-5.6-luna",
      task: "extraction",
    });
    expect(generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 8192,
        systemPrompt: "system",
        userPrompt: "user",
      }),
    );
  });

  it("does not silently fall back when the selected provider is unknown", async () => {
    process.env.IDEA_MAZE_LLM_PROVIDER = "unknown";
    const { generateBatchJson, getMissingLlmReason } = await import("./llm.ts");

    expect(getMissingLlmReason()).toBe(
      'LLM provider "unknown" is not registered',
    );
    await expect(generateBatchJson("system", "user")).rejects.toThrow(
      'LLM provider "unknown" is not registered',
    );
  });

  it("aborts stalled research requests before the stage-level timeout", async () => {
    global.fetch = vi.fn((_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as typeof fetch;

    const { generateResearchJson } = await import("./llm.ts");
    const pending = generateResearchJson("system", "user");
    const assertion = expect(pending).rejects.toThrow(
      "OpenAI API request timed out after 120000ms",
    );

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await assertion;
  });

  it("uses the exploration model and research token budget", async () => {
    vi.useRealTimers();
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        }),
        { status: 200 },
      ),
    ) as typeof fetch;
    const { generateExplorationJson } = await import("./llm.ts");

    await expect(generateExplorationJson("system", "user")).resolves.toEqual({
      ok: true,
    });
    const request = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.model).toBe("gpt-5.6-sol");
    expect(body.max_completion_tokens).toBe(8192);
  });
});
