import { afterEach, describe, expect, it, vi } from "vitest";

import { ResearchProviderError, type SearchRequest } from "./ports.js";
import { createTavilySearchBinding } from "./search-adapter.js";

const API_KEY = "test_tavily_key_do_not_return";

function makeRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    query: "site:reddit.com/r/example people describing a recurring task",
    purpose: "problem_language",
    limit: 5,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function responseWith(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof value === "string" ? value : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fetchReturning(response: Response | (() => Promise<Response>)) {
  const fetchMock = vi.fn(async () => typeof response === "function" ? response() : response);
  return fetchMock as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe("Tavily targeted search adapter", () => {
  it("reports missing credentials as an explicit safe capability", () => {
    const fetcher = fetchReturning(responseWith({ results: [] }));
    const binding = createTavilySearchBinding({ apiKey: null, fetch: fetcher });

    expect(binding).toEqual({ availability: "not_configured", adapter: null, provider: null });
    expect(JSON.stringify(binding)).not.toContain(API_KEY);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses one purpose-aware Tavily request and bounds normalized results", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => responseWith({
      results: [
        {
          url: "HTTPS://Example.com:443/problem#section",
          title: "  A title  ",
          content: "<script>provider text remains untrusted discovery data</script>",
        },
        { url: "https://example.com/problem#another-fragment", title: "duplicate", content: "duplicate" },
        { url: "https://user:password@example.net/private", title: "credential URL", content: "discard" },
        { url: "javascript:alert(1)", title: "unsupported scheme", content: "discard" },
        { url: "https://example.org/second", title: "second", content: "second result" },
        { url: "https://example.dev/extra", title: "over limit", content: "over limit" },
      ],
    }));
    const binding = createTavilySearchBinding({
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      config: { maxResults: 2 },
    });
    const provider = binding.provider!;

    const result = await provider.search(makeRequest({ limit: 19 }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      search_depth: "basic",
      max_results: 2,
      include_answer: false,
      include_raw_content: false,
      auto_parameters: false,
    });
    expect(body.query).toBe("site:reddit.com/r/example people describing a recurring task");
    expect(result).toEqual({
      results: [
        {
          url: "https://example.com/problem",
          title: "A title",
          snippet: "<script>provider text remains untrusted discovery data</script>",
        },
        { url: "https://example.org/second", title: "second", snippet: "second result" },
      ],
      requestsUsed: 1,
      costMicros: null,
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("sends the exact validated planner query for every purpose", async () => {
    const purposes = ["problem_language", "workaround", "alternative", "counterevidence"] as const;
    const plannerQuery = "site:reddit.com/r/sample exact planner text";
    for (const purpose of purposes) {
      let sentQuery = "";
      const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
        sentQuery = (JSON.parse(String(init?.body)) as { query: string }).query;
        return responseWith({ results: [] });
      });
      const provider = createTavilySearchBinding({
        apiKey: API_KEY,
        fetch: fetchMock as unknown as typeof fetch,
      }).provider!;

      await provider.search(makeRequest({ query: plannerQuery, purpose }));

      expect(sentQuery).toBe(plannerQuery);
    }
  });

  it("rejects invalid query bounds before making an outbound request", async () => {
    const fetcher = fetchReturning(responseWith({ results: [] }));
    const provider = createTavilySearchBinding({ apiKey: API_KEY, fetch: fetcher }).provider!;

    await expect(provider.search(makeRequest({ limit: 0 }))).rejects.toThrow("positive integer");
    await expect(provider.search(makeRequest({ query: "   " }))).rejects.toThrow("length limit");
    await expect(provider.search(makeRequest({ query: "q".repeat(801) }))).rejects.toThrow("length limit");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not allow configuration to exceed Tavily's result ceiling", () => {
    expect(() => createTavilySearchBinding({
      apiKey: API_KEY,
      fetch: fetchReturning(responseWith({ results: [] })),
      config: { maxResults: 21 },
    })).toThrow("between 1 and 20");
  });

  it("returns generic safe classifications for rate limit, auth, server, malformed JSON, and malformed shapes", async () => {
    const cases: Array<{ response: Response; kind: ResearchProviderError["kind"]; retryAfterSeconds?: number | null }> = [
      { response: responseWith("private provider detail", 429, { "Retry-After": "7" }), kind: "rate_limited", retryAfterSeconds: 7 },
      { response: responseWith("private provider detail", 401), kind: "unavailable" },
      { response: responseWith("private provider detail", 503), kind: "failed" },
      { response: responseWith("{not-json"), kind: "failed" },
      { response: responseWith({ results: "not-an-array" }), kind: "failed" },
    ];

    for (const { response, kind, retryAfterSeconds } of cases) {
      const provider = createTavilySearchBinding({ apiKey: API_KEY, fetch: fetchReturning(response) }).provider!;
      let thrown: unknown;
      try {
        await provider.search(makeRequest());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ResearchProviderError);
      expect((thrown as ResearchProviderError).kind).toBe(kind);
      if (retryAfterSeconds !== undefined) expect((thrown as ResearchProviderError).retryAfterSeconds).toBe(retryAfterSeconds);
      expect((thrown as Error).message).not.toContain(API_KEY);
      expect((thrown as Error).message).not.toContain("private provider detail");
    }
  });

  it("ignores malformed and unsafe result entries, bounds text, and deduplicates canonical URLs", async () => {
    const provider = createTavilySearchBinding({
      apiKey: API_KEY,
      fetch: fetchReturning(responseWith({
        results: [
          null,
          { url: 123 },
          { url: "https://example.com/a#one", title: "t".repeat(700), content: "s".repeat(4_000) },
          { url: "https://example.com/a#two", title: "duplicate" },
        ],
      })),
    }).provider!;

    const result = await provider.search(makeRequest({ limit: 5 }));

    expect(result.results).toHaveLength(1);
    expect(result.results[0].url).toBe("https://example.com/a");
    expect(result.results[0].title).toHaveLength(500);
    expect(result.results[0].snippet).toHaveLength(2_000);
  });

  it("rejects a response exceeding the configured body byte limit", async () => {
    const provider = createTavilySearchBinding({
      apiKey: API_KEY,
      fetch: fetchReturning(new Response("x".repeat(1_100))),
      config: { maxResponseBytes: 1_024 },
    }).provider!;

    await expect(provider.search(makeRequest())).rejects.toMatchObject({ kind: "failed" });
  });

  it("honors cancellation while an injected fetch is still pending", async () => {
    const fetchMock = vi.fn((_input: unknown, _init?: RequestInit) => new Promise<Response>(() => undefined));
    const provider = createTavilySearchBinding({
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
    }).provider!;
    const controller = new AbortController();
    const pending = provider.search(makeRequest({ signal: controller.signal }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect((fetchMock.mock.calls[0][0] as unknown as string)).toBe("https://api.tavily.com/search");
  });

  it("does not make an outbound request for a search cancelled before it starts", async () => {
    const fetcher = fetchReturning(responseWith({ results: [] }));
    const provider = createTavilySearchBinding({ apiKey: API_KEY, fetch: fetcher }).provider!;
    const controller = new AbortController();
    controller.abort();

    await expect(provider.search(makeRequest({ signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();

    const scheduledController = new AbortController();
    const scheduled = provider.search(makeRequest({ signal: scheduledController.signal }));
    scheduledController.abort();
    await expect(scheduled).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the injected fetch captured when the binding is constructed", async () => {
    const originalFetch = fetchReturning(responseWith({ results: [] }));
    const replacementFetch = fetchReturning(responseWith({ results: [] }));
    const options = { apiKey: API_KEY, fetch: originalFetch };
    const provider = createTavilySearchBinding(options).provider!;
    options.fetch = replacementFetch;

    await provider.search(makeRequest());

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(replacementFetch).not.toHaveBeenCalled();
  });

  it("cancels a response body that arrives after caller cancellation", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn((_input: unknown, _init?: RequestInit) => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const provider = createTavilySearchBinding({
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
    }).provider!;
    const controller = new AbortController();
    const pending = provider.search(makeRequest({ signal: controller.signal }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const cancelBody = vi.fn(async () => undefined);
    const lateResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { cancel: cancelBody },
    } as unknown as Response;
    resolveFetch(lateResponse);

    await vi.waitFor(() => expect(cancelBody).toHaveBeenCalledTimes(1));
  });

  it("honors cancellation while a response body read is pending", async () => {
    let cancelled = false;
    type TestReadResult = { done: boolean; value?: Uint8Array };
    const read = vi.fn<() => Promise<TestReadResult>>();
    read
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('{"results":') })
      .mockImplementationOnce(() => new Promise<TestReadResult>(() => undefined));
    const reader = {
      read,
      cancel: vi.fn(async () => { cancelled = true; }),
      releaseLock: vi.fn(),
    };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;
    const provider = createTavilySearchBinding({ apiKey: API_KEY, fetch: fetchReturning(response) }).provider!;
    const controller = new AbortController();
    const pending = provider.search(makeRequest({ signal: controller.signal }));
    await vi.waitFor(() => expect(reader.read).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });

  it("enforces the adapter timeout even when the injected fetch ignores AbortSignal", async () => {
    const fetchMock = vi.fn((_input: unknown, _init?: RequestInit) => new Promise<Response>(() => undefined));
    const provider = createTavilySearchBinding({
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
      config: { timeoutMs: 10 },
    }).provider!;

    await expect(provider.search(makeRequest())).rejects.toMatchObject({ kind: "failed" });
  });
});
