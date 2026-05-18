import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("generateResearchJson", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    process.env.ANTHROPIC_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  it("uses OpenAI when Anthropic is missing and OpenAI is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "openai-test-key";
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
    expect(getExtractionModel()).toBe("gpt-5-mini");
    expect(getResearchModel()).toBe("gpt-5.1");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"model":"gpt-5-mini"'),
        headers: expect.objectContaining({
          Authorization: "Bearer openai-test-key",
        }),
      }),
    );
  });

  it("prefers Anthropic when both Anthropic and OpenAI are configured", async () => {
    process.env.OPENAI_API_KEY = "openai-test-key";
    vi.useRealTimers();
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ content: [{ text: JSON.stringify({ ok: true }) }] }),
        { status: 200 },
      ),
    ) as typeof fetch;

    const { generateBatchJson, getConfiguredProvider } = await import(
      "./llm.ts"
    );

    await expect(generateBatchJson("system", "user")).resolves.toEqual({
      ok: true,
    });
    expect(getConfiguredProvider()).toBe("anthropic");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "test-key",
        }),
      }),
    );
  });

  it("falls back to OpenAI when Anthropic returns a retryable API error", async () => {
    process.env.OPENAI_API_KEY = "openai-test-key";
    vi.useRealTimers();
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { type: "overloaded_error", message: "Overloaded" },
          }),
          { status: 529 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
          }),
          { status: 200 },
        ),
      ) as typeof fetch;

    const { generateBatchJson, getConfiguredProvider } = await import(
      "./llm.ts"
    );

    await expect(generateBatchJson("system", "user")).resolves.toEqual({
      ok: true,
    });
    expect(getConfiguredProvider()).toBe("anthropic");
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        body: expect.stringContaining('"model":"claude-haiku-4-5-20251001"'),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining('"model":"gpt-5-mini"'),
        headers: expect.objectContaining({
          Authorization: "Bearer openai-test-key",
        }),
      }),
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
      "Anthropic API request timed out after 120000ms",
    );

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    await assertion;
  });
});
