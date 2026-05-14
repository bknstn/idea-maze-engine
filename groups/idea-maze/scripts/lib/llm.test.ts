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
