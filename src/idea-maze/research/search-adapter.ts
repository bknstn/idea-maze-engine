import {
  ResearchProviderError,
  unavailableProvider,
  type ProviderBinding,
  type SearchProvider,
  type SearchRequest,
  type SearchResponse,
} from "./ports.js";

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const MAX_TAVILY_RESULTS = 20;
const MAX_TITLE_LENGTH = 500;
const MAX_SNIPPET_LENGTH = 2_000;
const MAX_RESULT_URL_LENGTH = 2_048;
const SEARCH_PURPOSES = new Set(["problem_language", "workaround", "alternative", "counterevidence"]);

/** Hard limits keep caller configuration from removing the adapter's bounds. */
export interface TavilySearchConfig {
  timeoutMs: number;
  maxQueryChars: number;
  maxResults: number;
  maxResponseBytes: number;
}

export interface TavilySearchAdapterOptions {
  /** A key supplied by the owner application; never read from process globals. */
  apiKey?: string | null;
  /** Injected to make network access explicit and tests fully offline. */
  fetch: typeof fetch;
  config?: Partial<TavilySearchConfig>;
}

const DEFAULT_CONFIG: TavilySearchConfig = Object.freeze({
  timeoutMs: 10_000,
  maxQueryChars: 800,
  maxResults: 10,
  maxResponseBytes: 1_000_000,
});

/**
 * Create an explicit Tavily capability binding. Missing credentials produce a
 * safe `not_configured` capability; this adapter never searches environment
 * variables or falls back to the ambient global `fetch`.
 */
export function createTavilySearchBinding(options: TavilySearchAdapterOptions): ProviderBinding<SearchProvider> {
  if (!options || typeof options !== "object" || typeof options.fetch !== "function") {
    throw new TypeError("an injected fetch implementation is required");
  }

  const apiKey = options.apiKey;
  if (apiKey === null || apiKey === undefined || (typeof apiKey === "string" && apiKey.trim() === "")) {
    return unavailableProvider("not_configured");
  }
  if (typeof apiKey !== "string" || apiKey.length > 4_096 || apiKey.trim() !== apiKey || /[\u0000-\u001f\u007f]/u.test(apiKey)) {
    throw new TypeError("apiKey configuration is invalid");
  }

  const config = resolveConfig(options.config);
  const fetcher = options.fetch;
  const provider: SearchProvider = Object.freeze({
    search: (request: SearchRequest) => searchTavily(fetcher, apiKey, config, request),
  });
  return Object.freeze({ availability: "available", adapter: "tavily", provider });
}

function resolveConfig(config: Partial<TavilySearchConfig> | undefined): Readonly<TavilySearchConfig> {
  const resolved = { ...DEFAULT_CONFIG, ...config };
  if (!Number.isSafeInteger(resolved.timeoutMs) || resolved.timeoutMs < 1 || resolved.timeoutMs > 120_000) {
    throw new RangeError("timeoutMs must be an integer between 1 and 120000");
  }
  if (!Number.isSafeInteger(resolved.maxQueryChars) || resolved.maxQueryChars < 64 || resolved.maxQueryChars > 2_000) {
    throw new RangeError("maxQueryChars must be an integer between 64 and 2000");
  }
  if (!Number.isSafeInteger(resolved.maxResults) || resolved.maxResults < 1 || resolved.maxResults > MAX_TAVILY_RESULTS) {
    throw new RangeError("maxResults must be an integer between 1 and 20");
  }
  if (!Number.isSafeInteger(resolved.maxResponseBytes) || resolved.maxResponseBytes < 1_024 || resolved.maxResponseBytes > 4_000_000) {
    throw new RangeError("maxResponseBytes must be an integer between 1024 and 4000000");
  }
  return Object.freeze(resolved);
}

async function searchTavily(
  fetcher: typeof fetch,
  apiKey: string,
  config: Readonly<TavilySearchConfig>,
  request: SearchRequest,
): Promise<SearchResponse> {
  if (!request || typeof request !== "object" || typeof request.signal?.aborted !== "boolean") {
    throw new TypeError("a search request with an AbortSignal is required");
  }
  if (request.signal.aborted) throw makeAbortError();
  if (typeof request.query !== "string" || request.query.trim() === "" || request.query.length > config.maxQueryChars) {
    throw new RangeError("search query is outside the configured length limit");
  }
  if (typeof request.purpose !== "string" || !SEARCH_PURPOSES.has(request.purpose)) {
    throw new TypeError("search purpose is invalid");
  }
  if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
    throw new RangeError("search result limit must be a positive integer");
  }

  // Query text is part of the immutable, caller-previewed plan; purpose is
  // validated here but never silently rewrites the outbound search.
  const query = request.query;
  const maxResults = Math.min(request.limit, config.maxResults, MAX_TAVILY_RESULTS);
  const scope = createRequestScope(request.signal, config.timeoutMs);
  try {
    const fetchPromise = Promise.resolve().then(() => {
      if (scope.signal.aborted) throw scope.abortError();
      return fetcher(TAVILY_SEARCH_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          query,
          search_depth: "basic",
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false,
          auto_parameters: false,
        }),
        redirect: "error",
        signal: scope.signal,
      });
    }).then((response) => {
      // A fetch implementation may ignore AbortSignal and settle after the
      // caller has stopped waiting. Release the late response body promptly.
      if (scope.signal.aborted) cancelBody(response);
      return response;
    });
    const response = await raceWithSignal(fetchPromise, scope.signal, scope.abortError);
    if (!response.ok) {
      cancelBody(response);
      if (response.status === 429) {
        throw new ResearchProviderError("rate_limited", parseRetryAfter(response.headers.get("retry-after")));
      }
      if (response.status === 401 || response.status === 403) {
        throw new ResearchProviderError("unavailable");
      }
      throw new ResearchProviderError("failed");
    }

    const contentLength = parseContentLength(response.headers.get("content-length"));
    if (contentLength !== null && contentLength > config.maxResponseBytes) {
      cancelBody(response);
      throw new ResearchProviderError("failed");
    }
    const text = await readBoundedBody(response, config.maxResponseBytes, scope.signal, scope.abortError);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new ResearchProviderError("failed");
    }

    const results = normalizeResults(payload, maxResults);
    return { results, requestsUsed: 1, costMicros: null };
  } catch (error) {
    if (scope.signal.aborted) throw scope.abortError();
    if (error instanceof ResearchProviderError) throw error;
    throw new ResearchProviderError("failed");
  } finally {
    scope.dispose();
  }
}

function normalizeResults(payload: unknown, limit: number): SearchResponse["results"] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new ResearchProviderError("failed");

  const output: SearchResponse["results"] = [];
  const seen = new Set<string>();
  for (const entry of payload.results) {
    if (!isRecord(entry) || typeof entry.url !== "string") continue;
    const url = normalizeResultUrl(entry.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    output.push({
      url,
      title: boundedText(entry.title, MAX_TITLE_LENGTH),
      snippet: boundedText(entry.content, MAX_SNIPPET_LENGTH),
    });
    if (output.length >= limit) break;
  }
  return output;
}

function normalizeResultUrl(input: string): string | null {
  if (input.length === 0 || input.length > MAX_RESULT_URL_LENGTH) return null;
  try {
    const url = new URL(input);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized === "" ? null : normalized.slice(0, maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed <= 86_400 ? parsed : null;
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The body is untrusted; cancellation is best-effort and has no caller data.
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  abortError: () => Error,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ResearchProviderError("failed");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let part: Awaited<ReturnType<typeof reader.read>>;
      try {
        part = await raceWithSignal(reader.read(), signal, abortError);
      } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
      }
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new ResearchProviderError("failed");
      totalBytes += part.value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new ResearchProviderError("failed");
      }
      chunks.push(part.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read may still be settling after cancellation.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ResearchProviderError("failed");
  }
}

function createRequestScope(callerSignal: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  abortError(): Error;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (callerSignal.aborted) onCallerAbort();
  else callerSignal.addEventListener("abort", onCallerAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    abortError: () => callerSignal.aborted ? makeAbortError() : timedOut ? new ResearchProviderError("failed") : makeAbortError(),
    dispose() {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", onCallerAbort);
    },
  };
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal, abortError: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function makeAbortError(): Error {
  return new DOMException("Search request cancelled", "AbortError");
}
