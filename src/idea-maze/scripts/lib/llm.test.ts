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
    expect(body.response_format).toEqual({ type: "json_object" });
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

  it("routes bounded task JSON through the selected adapter and preserves unknown usage", async () => {
    const { generateTaskJson, registerLlmProvider } = await import("./llm.ts");
    const generateJson = vi.fn(async (request: LlmRequest) => ({
      task: request.task,
      model: request.model,
      maxTokens: request.maxTokens,
    }));
    registerLlmProvider({
      name: "bounded-test",
      displayName: "Bounded Test",
      environmentAware: true,
      isConfigured: (environment) => environment?.TEST_PROVIDER_KEY === "synthetic-key",
      inputTokenUpperBound: (request) => Buffer.byteLength(request.systemPrompt) + Buffer.byteLength(request.userPrompt) + 8,
      async generateJson<T>(request: LlmRequest): Promise<T> {
        return (await generateJson(request)) as T;
      },
    });
    const controller = new AbortController();

    await expect(generateTaskJson({
      task: "research",
      systemPrompt: "system",
      userPrompt: "user",
      maxInputTokens: 20,
      maxOutputTokens: 12,
      signal: controller.signal,
      environment: {
        IDEA_MAZE_LLM_PROVIDER: "bounded-test",
        IDEA_MAZE_RESEARCH_MODEL: "synthetic-research-model",
        TEST_PROVIDER_KEY: "synthetic-key",
      },
    })).resolves.toEqual({
      value: { task: "research", model: "synthetic-research-model", maxTokens: 12 },
      usage: { inputTokens: null, outputTokens: null, costMicros: null },
    });
    expect(generateJson).toHaveBeenCalledWith(expect.objectContaining({
      task: "research",
      model: "synthetic-research-model",
      maxTokens: 12,
      signal: controller.signal,
    }));
  });

  it("fails closed when the adapter cannot admit the input budget or the bound is too large", async () => {
    const { generateTaskJson, LlmInputBudgetError, registerLlmProvider } = await import("./llm.ts");
    const unsupportedGenerate = vi.fn(async () => ({ ok: true }));
    registerLlmProvider({
      name: "no-bound-test",
      displayName: "No Bound Test",
      environmentAware: true,
      isConfigured: () => true,
      async generateJson<T>(): Promise<T> {
        return (await unsupportedGenerate()) as T;
      },
    });
    const request = {
      task: "research" as const,
      systemPrompt: "system",
      userPrompt: "user",
      maxInputTokens: 100,
      maxOutputTokens: 20,
      signal: new AbortController().signal,
      environment: { IDEA_MAZE_LLM_PROVIDER: "no-bound-test" },
    };
    await expect(generateTaskJson(request)).rejects.toMatchObject(expect.objectContaining({
      name: "LlmInputBudgetError",
      reason: "unsupported",
    }));
    expect(unsupportedGenerate).not.toHaveBeenCalled();

    const boundedGenerate = vi.fn(async () => ({ ok: true }));
    registerLlmProvider({
      name: "over-budget-test",
      displayName: "Over Budget Test",
      environmentAware: true,
      isConfigured: () => true,
      inputTokenUpperBound: () => 101,
      async generateJson<T>(): Promise<T> {
        return (await boundedGenerate()) as T;
      },
    });
    await expect(generateTaskJson({
      ...request,
      maxInputTokens: 100,
      environment: { IDEA_MAZE_LLM_PROVIDER: "over-budget-test" },
    })).rejects.toMatchObject({ reason: "exceeded" });
    expect(boundedGenerate).not.toHaveBeenCalled();
  });

  it("passes the service-owned abort signal into the OpenAI HTTP request", async () => {
    global.fetch = vi.fn(async (_url, init) => new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }),
      { status: 200 },
    )) as typeof fetch;
    const { generateTaskJson } = await import("./llm.ts");
    const controller = new AbortController();
    const environment = { OPENAI_API_KEY: "synthetic-key", IDEA_MAZE_LLM_PROVIDER: "openai" };

    await expect(generateTaskJson({
      task: "research",
      systemPrompt: "system",
      userPrompt: "user",
      maxInputTokens: 2_000,
      maxOutputTokens: 19,
      signal: controller.signal,
      environment,
    })).resolves.toMatchObject({ value: { ok: true }, usage: { inputTokens: null } });
    const init = vi.mocked(global.fetch).mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(String(init.body)).max_completion_tokens).toBe(19);
  });

  it("does not fall back to ambient credentials when a host supplies an explicit environment", async () => {
    const fetch = vi.fn();
    global.fetch = fetch as unknown as typeof global.fetch;
    const { generateTaskJson } = await import("./llm.ts");

    await expect(generateTaskJson({
      task: "research",
      systemPrompt: "system",
      userPrompt: "user",
      maxInputTokens: 2_000,
      maxOutputTokens: 20,
      signal: new AbortController().signal,
      environment: { IDEA_MAZE_LLM_PROVIDER: "openai" },
    })).rejects.toThrow('LLM provider "openai" is not configured');
    expect(fetch).not.toHaveBeenCalled();
  });
});
