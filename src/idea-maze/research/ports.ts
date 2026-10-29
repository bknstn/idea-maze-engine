import type { ProviderAvailability, ResearchCapability } from "./contracts.js";

export type { ProviderAvailability, ResearchCapability } from "./contracts.js";

/**
 * Provider and infrastructure seams for the hypothesis research application.
 * These ports are deliberately vendor-neutral and do not read process globals.
 */

export type ResearchModelTask = "extraction" | "research" | "exploration";

export interface TokenBudget {
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Null when the provider does not report or price usage. */
  costMicros: number | null;
}

export interface ModelRequest extends TokenBudget {
  task: ResearchModelTask;
  systemPrompt: string;
  userPrompt: string;
  /** This signal belongs to the service/run, never to an HTTP request. */
  signal: AbortSignal;
}

export interface ModelResponse<T> {
  value: T;
  usage: ProviderUsage;
}

export interface ModelProvider {
  /** Adapter-owned token admission bound; null means the adapter cannot enforce a cap. */
  inputTokenUpperBound?(request: Omit<ModelRequest, "signal">): number | null;
  generateJson<T>(request: ModelRequest): Promise<ModelResponse<T>>;
}

export type SearchPurpose = "problem_language" | "workaround" | "alternative" | "counterevidence";

export interface SearchRequest {
  query: string;
  purpose: SearchPurpose;
  limit: number;
  signal: AbortSignal;
}

export interface SearchHit {
  url: string;
  title: string | null;
  snippet: string | null;
}

export interface SearchResponse {
  results: SearchHit[];
  /** Null when the provider does not report request usage. */
  requestsUsed: number | null;
  /** Null when the provider does not report or price usage. */
  costMicros: number | null;
}

export interface SearchProvider {
  search(request: SearchRequest): Promise<SearchResponse>;
}

export interface OriginalSourceRequest {
  /** A URL selected by the research workflow, not a caller-supplied filesystem path. */
  url: string;
  signal: AbortSignal;
}

/**
 * Normalized fetched source data. Persistence assigns source item identifiers;
 * adapters must not invent or reserve SQLite IDs.
 */
export interface FetchedOriginal {
  canonicalUrl: string;
  retrievedAt: string;
  title: string | null;
  contentType: string | null;
  text: string;
  textHash: string;
}

export interface OriginalSourceReader {
  fetchOriginal(request: OriginalSourceRequest): Promise<FetchedOriginal>;
}

/** `adapter` is a public family label only; credentials are never part of a binding. */
export interface ProviderBinding<T> {
  availability: ProviderAvailability;
  adapter: string | null;
  provider: T | null;
}

export interface ResearchProviderBindings {
  model: ProviderBinding<ModelProvider>;
  search: ProviderBinding<SearchProvider>;
  originalSourceReader: ProviderBinding<OriginalSourceReader>;
}

export type ResearchModelTaskLogValue = ResearchModelTask;
export type ResearchLogEvent =
  | "provider.request_started"
  | "provider.request_finished"
  | "provider.request_failed"
  | "service.shutdown";

/**
 * Restricted diagnostic fields keep raw prompts, source bodies, paths,
 * workspace keys, provider errors, and credentials out of routine logs.
 */
export interface SafeLogEntry {
  event: ResearchLogEvent;
  capability?: ResearchCapability;
  adapter?: string;
  task?: ResearchModelTaskLogValue;
  outcome?: "succeeded" | "failed" | "cancelled";
  errorCode?: "PROVIDER_UNAVAILABLE" | "LIMIT_EXCEEDED" | "INTERNAL_ERROR";
  durationMilliseconds?: number;
  itemCount?: number;
}

export interface StructuredSafeLogger {
  log(entry: Readonly<SafeLogEntry>): void;
}

export type ProviderFailureKind = "unavailable" | "rate_limited" | "failed";

/** Safe provider classification without retaining or reflecting raw responses. */
export class ResearchProviderError extends Error {
  readonly kind: ProviderFailureKind;
  readonly retryAfterSeconds: number | null;

  constructor(kind: ProviderFailureKind, retryAfterSeconds: number | null = null) {
    super("Research provider request failed");
    this.name = "ResearchProviderError";
    this.kind = kind;
    this.retryAfterSeconds =
      Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds !== null && retryAfterSeconds >= 0
        ? retryAfterSeconds
        : null;
  }
}

export interface ResearchClock {
  now(): Date;
}

export type ResearchIdKind = "case" | "hypothesis" | "suggestion" | "plan" | "query" | "run" | "evidence";
export type ResearchIdFactory = (kind: ResearchIdKind) => string;

/** Explicit status is required even when a provider is absent. */
export function unavailableProvider<T>(availability: Exclude<ProviderAvailability, "available">): ProviderBinding<T> {
  return { availability, adapter: null, provider: null };
}

/** Build the intentionally offline-capable default provider set. */
export function noResearchProviders(): ResearchProviderBindings {
  return {
    model: unavailableProvider("not_configured"),
    search: unavailableProvider("not_configured"),
    originalSourceReader: unavailableProvider("not_configured"),
  };
}
