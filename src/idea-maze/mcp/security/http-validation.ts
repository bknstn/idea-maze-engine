import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

import { createBearerCredentialStore, type BearerCredentialStore, type HttpBearerCredential } from "./http-auth.js";

export type LoopbackHttpBindHost = "127.0.0.1" | "::1";

export interface HttpRateLimitConfiguration {
  requests: number;
  windowMilliseconds: number;
  maxTrackedPeers: number;
}

export interface HttpSecurityConfiguration {
  readonly bindHost: LoopbackHttpBindHost;
  readonly maxRequestBodyBytes: number;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
  readonly allowMissingOrigin: boolean;
  readonly rateLimit: Readonly<HttpRateLimitConfiguration>;
  readonly trustedProxyPeers: readonly string[];
  readonly authorize: (request: IncomingMessage) => HttpSecurityDecision;
  readonly authorizeHealthCheck: (request: IncomingMessage) => HttpSecurityDecision;
  readonly rotateCredentials: BearerCredentialStore["replaceCredentials"];
  readonly revokeCredential: BearerCredentialStore["revoke"];
}

export type HttpSecurityDecision =
  | { allowed: true; status?: undefined; retryAfterSeconds?: undefined }
  | { allowed: false; status: 400 | 401 | 403 | 429 | 503; retryAfterSeconds?: number };

interface RateBucket {
  startedAt: number;
  requests: number;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RATE_REQUESTS = 10_000;
const MAX_RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_PEERS = 4096;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
const validatedPolicies = new WeakSet<object>();

/**
 * Validate HTTP trust policy and create the request authorization boundary.
 * The returned policy binds credentials, allowlists, proxy trust, rate bounds,
 * and the injected clock in closures; it has no ambient environment defaults.
 */
export function createHttpSecurityConfiguration(input: {
  credentials: readonly HttpBearerCredential[];
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  bindHost?: LoopbackHttpBindHost;
  allowMissingOrigin?: boolean;
  maxRequestBodyBytes?: number;
  rateLimit?: Partial<HttpRateLimitConfiguration>;
  trustedProxyPeers?: readonly string[];
  now?: () => number;
}): HttpSecurityConfiguration {
  const bindHost = input.bindHost ?? "127.0.0.1";
  if (bindHost !== "127.0.0.1" && bindHost !== "::1") {
    throw new TypeError("HTTP MCP bind host must be loopback");
  }
  const maxRequestBodyBytes = input.maxRequestBodyBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1024 || maxRequestBodyBytes > MAX_BODY_BYTES) {
    throw new RangeError(`maxRequestBodyBytes must be an integer between 1024 and ${MAX_BODY_BYTES}`);
  }
  const allowedHosts = normalizeHostAllowlist(input.allowedHosts);
  const allowedOrigins = normalizeOriginAllowlist(input.allowedOrigins);
  const allowMissingOrigin = input.allowMissingOrigin ?? true;
  if (typeof allowMissingOrigin !== "boolean") throw new TypeError("allowMissingOrigin must be boolean");
  const rateLimit = validateRateLimit(input.rateLimit);
  const trustedProxyPeers = normalizePeerAllowlist(input.trustedProxyPeers ?? []);
  if (input.now !== undefined && typeof input.now !== "function") throw new TypeError("now must be a function");
  const now = input.now ?? Date.now;

  const credentialStore = createBearerCredentialStore(input.credentials);
  const buckets = new Map<string, RateBucket>();
  let lastObservedTime = Number.NEGATIVE_INFINITY;

  const authorizeRequest = (request: IncomingMessage, requireAuthentication: boolean): HttpSecurityDecision => {
    const observedTime = now();
    if (!Number.isFinite(observedTime)) return { allowed: false, status: 503 };
    const timestamp = Math.max(observedTime, lastObservedTime);
    lastObservedTime = timestamp;

    const peer = request.socket.remoteAddress ?? "unknown";
    const rateResult = checkRateLimit(buckets, peer, timestamp, rateLimit);
    if (!rateResult.allowed) return rateResult;

    const proxy = validateForwardedHeaders(request, trustedProxyPeers);
    if (!proxy.allowed) return proxy;

    const hostHeader = getSingleRawHeader(request, "host");
    if (hostHeader.kind !== "one" || !hostMatches(hostHeader.value, allowedHosts, request.socket.localPort, proxy.trustedTlsProxy === true)) {
      return { allowed: false, status: hostHeader.kind === "invalid" ? 400 : 403 };
    }

    const originHeader = getSingleRawHeader(request, "origin");
    if (originHeader.kind === "invalid") return { allowed: false, status: 400 };
    if (originHeader.kind === "one") {
      if (!originMatches(originHeader.value, allowedOrigins)) {
        return { allowed: false, status: 403 };
      }
    } else if (!allowMissingOrigin) {
      return { allowed: false, status: 403 };
    }

    if (!requireAuthentication) return { allowed: true };
    const authorization = getSingleRawHeader(request, "authorization");
    if (authorization.kind !== "one") return { allowed: false, status: authorization.kind === "invalid" ? 400 : 401 };
    const match = /^Bearer ([A-Za-z0-9._~-]{32,512})$/iu.exec(authorization.value);
    if (!match || !credentialStore.authenticate(match[1], timestamp)) return { allowed: false, status: 401 };
    return { allowed: true };
  };
  const authorize = (request: IncomingMessage): HttpSecurityDecision => authorizeRequest(request, true);
  const authorizeHealthCheck = (request: IncomingMessage): HttpSecurityDecision => authorizeRequest(request, false);

  const policy: HttpSecurityConfiguration = Object.freeze({
    bindHost,
    maxRequestBodyBytes,
    allowedHosts: Object.freeze([...allowedHosts]),
    allowedOrigins: Object.freeze([...allowedOrigins]),
    allowMissingOrigin,
    rateLimit: Object.freeze(rateLimit),
    trustedProxyPeers: Object.freeze([...trustedProxyPeers]),
    authorize,
    authorizeHealthCheck,
    rotateCredentials: credentialStore.replaceCredentials,
    revokeCredential: credentialStore.revoke,
  });
  validatedPolicies.add(policy);
  return policy;
}

/** Runtime brand check used by the HTTP adapter to reject forged policy objects. */
export function isHttpSecurityConfiguration(value: unknown): value is HttpSecurityConfiguration {
  return typeof value === "object" && value !== null && validatedPolicies.has(value);
}

type HeaderResult = { kind: "missing" } | { kind: "invalid" } | { kind: "one"; value: string };

/** Reads a security-sensitive header from rawHeaders so duplicates cannot be hidden by normalization. */
export function getSingleRawHeader(request: IncomingMessage, name: string): HeaderResult {
  const rawHeaders = request.rawHeaders;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return { kind: "invalid" };
  let value: string | undefined;
  let count = 0;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (typeof rawHeaders[index] !== "string" || typeof rawHeaders[index + 1] !== "string") return { kind: "invalid" };
    if (rawHeaders[index].toLowerCase() === name.toLowerCase()) {
      count += 1;
      value = rawHeaders[index + 1];
    }
  }
  if (count === 0) return { kind: "missing" };
  if (count !== 1 || typeof value !== "string" || /[\r\n\0]/u.test(value)) return { kind: "invalid" };
  return { kind: "one", value };
}

export function normalizeHostAllowlist(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 64) {
    throw new RangeError("allowedHosts must contain between 1 and 64 hostnames");
  }
  const normalized = values.map((host) => normalizeHostname(host));
  if (new Set(normalized).size !== normalized.length) throw new TypeError("allowedHosts entries must be unique");
  return normalized;
}

export function normalizeOriginAllowlist(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 64) throw new RangeError("allowedOrigins must contain at most 64 origins");
  const normalized: string[] = [];
  for (const input of values) {
    if (typeof input !== "string" || input.length > 512 || input === "null") throw new TypeError("allowedOrigins entries must be explicit HTTP(S) origins");
    let parsed: URL;
    try { parsed = new URL(input); } catch { throw new TypeError("allowedOrigins entries must be explicit HTTP(S) origins"); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== input) {
      throw new TypeError("allowedOrigins entries must be canonical HTTP(S) origins without paths or credentials");
    }
    normalized.push(parsed.origin);
  }
  if (new Set(normalized).size !== normalized.length) throw new TypeError("allowedOrigins entries must be unique");
  return normalized;
}

function validateRateLimit(input: Partial<HttpRateLimitConfiguration> | undefined): HttpRateLimitConfiguration {
  const result = {
    requests: input?.requests ?? 120,
    windowMilliseconds: input?.windowMilliseconds ?? 60_000,
    maxTrackedPeers: input?.maxTrackedPeers ?? 1024,
  };
  if (!Number.isSafeInteger(result.requests) || result.requests < 1 || result.requests > MAX_RATE_REQUESTS) {
    throw new RangeError(`rateLimit.requests must be an integer between 1 and ${MAX_RATE_REQUESTS}`);
  }
  if (!Number.isSafeInteger(result.windowMilliseconds) || result.windowMilliseconds < 1000 || result.windowMilliseconds > MAX_RATE_WINDOW_MS) {
    throw new RangeError(`rateLimit.windowMilliseconds must be an integer between 1000 and ${MAX_RATE_WINDOW_MS}`);
  }
  if (!Number.isSafeInteger(result.maxTrackedPeers) || result.maxTrackedPeers < 1 || result.maxTrackedPeers > MAX_TRACKED_PEERS) {
    throw new RangeError(`rateLimit.maxTrackedPeers must be an integer between 1 and ${MAX_TRACKED_PEERS}`);
  }
  return result;
}

function checkRateLimit(
  buckets: Map<string, RateBucket>,
  peer: string,
  now: number,
  config: HttpRateLimitConfiguration,
): HttpSecurityDecision {
  for (const [key, bucket] of buckets) {
    if (now - bucket.startedAt >= config.windowMilliseconds || now < bucket.startedAt) buckets.delete(key);
  }
  let bucket = buckets.get(peer);
  if (!bucket) {
    if (buckets.size >= config.maxTrackedPeers) return { allowed: false, status: 429, retryAfterSeconds: 1 };
    bucket = { startedAt: now, requests: 0 };
    buckets.set(peer, bucket);
  }
  if (bucket.requests >= config.requests) {
    return {
      allowed: false,
      status: 429,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + config.windowMilliseconds - now) / 1000)),
    };
  }
  bucket.requests += 1;
  return { allowed: true };
}

function normalizeHostname(value: string): string {
  if (typeof value !== "string" || value.length > 253 || value.trim() !== value || value.includes("/") || value.includes("@") || value.includes("#") || value.includes("?")) {
    throw new TypeError("allowedHosts entries must be hostnames or IP literals without ports");
  }
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (isIP(unbracketed) === 6) return unbracketed.toLowerCase();
  const hostname = unbracketed.toLowerCase().replace(/\.$/u, "");
  if (!HOSTNAME_PATTERN.test(hostname) && isIP(hostname) !== 4) throw new TypeError("allowedHosts entries must be valid DNS names or IP literals");
  return hostname;
}

function hostMatches(header: string, allowlist: readonly string[], localPort: number | undefined, trustedTlsProxy: boolean): boolean {
  if (!header || header.length > 512 || /[\s,\\/@?#%]/u.test(header)) return false;
  let parsed: URL;
  try { parsed = new URL(`http://${header}`); } catch { return false; }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
  const hostname = normalizeIncomingHostname(parsed.hostname);
  const port = parsed.port ? Number(parsed.port) : 80;
  return allowlist.includes(hostname) && (trustedTlsProxy || (Number.isSafeInteger(localPort) && port === localPort));
}

function originMatches(header: string, allowlist: readonly string[]): boolean {
  if (!header || header.length > 512 || header === "null" || /[,\s]/u.test(header)) return false;
  let parsed: URL;
  try { parsed = new URL(header); } catch { return false; }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== header) return false;
  return allowlist.includes(parsed.origin);
}

function normalizeIncomingHostname(hostname: string): string {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return unbracketed.toLowerCase().replace(/\.$/u, "");
}

function normalizePeerAllowlist(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 32) throw new RangeError("trustedProxyPeers must contain at most 32 IP addresses");
  const normalized: string[] = [];
  for (const peer of values) {
    if (typeof peer !== "string" || isIP(peer) === 0) throw new TypeError("trusted proxy peers must be IP literals");
    normalized.push(normalizePeer(peer));
  }
  if (new Set(normalized).size !== normalized.length) throw new TypeError("trustedProxyPeers entries must be unique");
  return normalized;
}

function validateForwardedHeaders(
  request: IncomingMessage,
  trustedPeers: readonly string[],
): HttpSecurityDecision & { trustedTlsProxy?: boolean } {
  if (!Array.isArray(request.rawHeaders) || request.rawHeaders.length % 2 !== 0) return { allowed: false, status: 400 };
  const names: string[] = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    if (typeof request.rawHeaders[index] !== "string") return { allowed: false, status: 400 };
    const name = request.rawHeaders[index].toLowerCase();
    if (name === "forwarded" || name.startsWith("x-forwarded-")) names.push(name);
  }
  const peer = normalizePeer(request.socket.remoteAddress ?? "");
  const trustedTlsProxy = trustedPeers.includes(peer);
  if (names.length === 0) return trustedTlsProxy ? { allowed: false, status: 403 } : { allowed: true };
  if (!trustedTlsProxy) return { allowed: false, status: 403 };
  if (names.some((name) => name !== "x-forwarded-proto") || names.filter((name) => name === "x-forwarded-proto").length !== 1) {
    return { allowed: false, status: 403 };
  }
  const proto = getSingleRawHeader(request, "x-forwarded-proto");
  if (proto.kind !== "one" || proto.value.toLowerCase() !== "https") return { allowed: false, status: 403 };
  return { allowed: true, trustedTlsProxy: true };
}

function normalizePeer(peer: string): string {
  if (peer.startsWith("::ffff:")) return peer.slice("::ffff:".length).toLowerCase();
  return peer.toLowerCase();
}
