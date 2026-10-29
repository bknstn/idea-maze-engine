import { afterEach, describe, expect, it, vi } from "vitest";

import type { LlmRequest } from "../scripts/lib/llm.js";

describe("registered research model binding", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("routes the task with output and input bounds and keeps unavailable usage unknown", async () => {
    const [{ registerLlmProvider }, { createRegisteredModelBinding }] = await Promise.all([
      import("../scripts/lib/llm.js"),
      import("./model-adapter.js"),
    ]);
    const generateJson = vi.fn(async (request: LlmRequest) => ({
      task: request.task,
      model: request.model,
      maxTokens: request.maxTokens,
      signal: request.signal,
    }));
    registerLlmProvider({
      name: "model-binding-test",
      displayName: "Model Binding Test",
      environmentAware: true,
      isConfigured: (environment) => environment?.TEST_MODEL_KEY === "synthetic-key",
      inputTokenUpperBound: (request) => Buffer.byteLength(JSON.stringify([
        request.systemPrompt,
        request.userPrompt,
      ])) + 8,
      async generateJson<T>(request: LlmRequest): Promise<T> {
        return (await generateJson(request)) as T;
      },
    });
    const environment = {
      IDEA_MAZE_LLM_PROVIDER: "model-binding-test",
      IDEA_MAZE_RESEARCH_MODEL: "synthetic-research-model",
      TEST_MODEL_KEY: "synthetic-key",
    };
    const binding = createRegisteredModelBinding({ environment });
    const signal = new AbortController().signal;

    expect(binding.availability).toBe("available");
    expect(binding.adapter).toBe("registered-task-model");
    const response = await binding.provider!.generateJson<{ task: string; model: string; maxTokens: number; signal: AbortSignal }>({
      task: "research",
      systemPrompt: "Synthetic system instructions.",
      userPrompt: "Synthetic input.",
      maxInputTokens: 2_000,
      maxOutputTokens: 123,
      signal,
    });

    expect(response.value).toEqual({
      task: "research",
      model: "synthetic-research-model",
      maxTokens: 123,
      signal,
    });
    expect(response.usage).toEqual({ inputTokens: null, outputTokens: null, costMicros: null });
    expect(generateJson).toHaveBeenCalledOnce();
  });

  it("reports absent or unknown providers as unavailable without fallback", async () => {
    const [{ registerLlmProvider }, { createRegisteredModelBinding }] = await Promise.all([
      import("../scripts/lib/llm.js"),
      import("./model-adapter.js"),
    ]);
    const fallback = vi.fn();
    registerLlmProvider({
      name: "unselected-fallback-test",
      displayName: "Fallback Test",
      environmentAware: true,
      isConfigured: () => true,
      inputTokenUpperBound: () => 10,
      async generateJson<T>(): Promise<T> {
        fallback();
        return {} as T;
      },
    });

    const unknown = createRegisteredModelBinding({ environment: { IDEA_MAZE_LLM_PROVIDER: "missing-test" } });
    expect(unknown).toEqual({ availability: "unavailable", adapter: null, provider: null });
    const unconfigured = createRegisteredModelBinding({ environment: { IDEA_MAZE_LLM_PROVIDER: "openai", OPENAI_API_KEY: "" } });
    expect(unconfigured).toEqual({ availability: "not_configured", adapter: null, provider: null });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("binds an immutable environment snapshot to the selected provider and model", async () => {
    const [{ registerLlmProvider }, { createRegisteredModelBinding }] = await Promise.all([
      import("../scripts/lib/llm.js"),
      import("./model-adapter.js"),
    ]);
    const requestSeen = vi.fn();
    registerLlmProvider({
      name: "environment-snapshot-test",
      displayName: "Environment Snapshot Test",
      environmentAware: true,
      isConfigured: (environment) => environment?.SNAPSHOT_KEY === "original-key",
      inputTokenUpperBound: () => 16,
      async generateJson<T>(request: LlmRequest): Promise<T> {
        requestSeen(request);
        return { model: request.model } as T;
      },
    });
    const environment: Record<string, string | undefined> = {
      IDEA_MAZE_LLM_PROVIDER: "environment-snapshot-test",
      IDEA_MAZE_RESEARCH_MODEL: "original-model",
      SNAPSHOT_KEY: "original-key",
    };
    const binding = createRegisteredModelBinding({ environment });
    environment.IDEA_MAZE_LLM_PROVIDER = "missing-provider-after-binding";
    environment.IDEA_MAZE_RESEARCH_MODEL = "changed-model";
    environment.SNAPSHOT_KEY = "changed-key";

    const response = await binding.provider!.generateJson<{ model: string }>({
      task: "research",
      systemPrompt: "system",
      userPrompt: "user",
      maxInputTokens: 100,
      maxOutputTokens: 20,
      signal: new AbortController().signal,
    });

    expect(response.value.model).toBe("original-model");
    expect(requestSeen).toHaveBeenCalledWith(expect.objectContaining({
      model: "original-model",
      environment: expect.objectContaining({ SNAPSHOT_KEY: "original-key" }),
    }));
  });
});
