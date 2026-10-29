import { createHttpSecurityConfiguration, type LoopbackHttpBindHost, type HttpSecurityConfiguration } from "./http-validation.js";

export const DEFAULT_RESEARCH_MCP_HTTP_PORT = 8787;

const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;
const MAX_JSON_ENVIRONMENT_VALUE_BYTES = 16 * 1024;
const MAX_RATE_REQUESTS = 10_000;
const MAX_RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_PEERS = 4096;
const ISO_TIMESTAMP_WITH_TIMEZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/u;

export type ResearchMcpTransport = "http" | "stdio";

export interface ResearchMcpHttpEnvironmentConfiguration {
  readonly host: LoopbackHttpBindHost;
  readonly port: number;
  readonly security: HttpSecurityConfiguration;
}

/** Read the only supported process transport selector. HTTP is the primary default. */
export function readResearchMcpTransport(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResearchMcpTransport {
  const value = environment.IDEA_MAZE_MCP_TRANSPORT;
  if (value === undefined || value === "http") return "http";
  if (value === "stdio") return "stdio";
  throw new TypeError("IDEA_MAZE_MCP_TRANSPORT must be `http` or `stdio`.");
}

/**
 * Build the mandatory T18 HTTP policy from a bounded, explicit environment
 * snapshot. The bearer value is accepted only from environment/secret config,
 * requires a future expiry, and is never included in returned policy fields.
 */
export function createResearchMcpHttpEnvironmentConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  now: () => number = Date.now,
): ResearchMcpHttpEnvironmentConfiguration {
  const bindHost = readBindHost(environment);
  const port = readInteger(environment, "IDEA_MAZE_MCP_HTTP_PORT", DEFAULT_RESEARCH_MCP_HTTP_PORT, 0, 65_535);
  const token = readRequiredSecret(environment, "IDEA_MAZE_MCP_BEARER_TOKEN");
  const expiresAt = readRequiredExpiry(environment);
  const allowedHosts = readJsonStringList(environment, "IDEA_MAZE_MCP_ALLOWED_HOSTS", DEFAULT_ALLOWED_HOSTS, 64);
  const allowedOrigins = readJsonStringList(environment, "IDEA_MAZE_MCP_ALLOWED_ORIGINS", [], 64);
  const trustedProxyPeers = readJsonStringList(environment, "IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS", [], 32);

  const maxRequestBodyBytes = readOptionalInteger(environment, "IDEA_MAZE_MCP_HTTP_MAX_BODY_BYTES", 1024, 1024 * 1024);
  const requests = readOptionalInteger(environment, "IDEA_MAZE_MCP_HTTP_RATE_LIMIT_REQUESTS", 1, MAX_RATE_REQUESTS);
  const windowMilliseconds = readOptionalInteger(environment, "IDEA_MAZE_MCP_HTTP_RATE_LIMIT_WINDOW_MS", 1000, MAX_RATE_WINDOW_MS);
  const maxTrackedPeers = readOptionalInteger(environment, "IDEA_MAZE_MCP_HTTP_RATE_LIMIT_MAX_TRACKED_PEERS", 1, MAX_TRACKED_PEERS);
  const hasRateOverride = requests !== undefined || windowMilliseconds !== undefined || maxTrackedPeers !== undefined;

  const observedNow = now();
  if (!Number.isSafeInteger(observedNow) || expiresAt <= observedNow) {
    throw new TypeError("IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT must be a future timestamp.");
  }

  const security = createHttpSecurityConfiguration({
    credentials: [{ id: "owner", token, expiresAt }],
    allowedHosts,
    allowedOrigins,
    bindHost,
    trustedProxyPeers,
    ...(maxRequestBodyBytes === undefined ? {} : { maxRequestBodyBytes }),
    ...(hasRateOverride ? { rateLimit: { requests, windowMilliseconds, maxTrackedPeers } } : {}),
    now,
  });
  return Object.freeze({ host: bindHost, port, security });
}

function readBindHost(environment: Readonly<Record<string, string | undefined>>): LoopbackHttpBindHost {
  const value = environment.IDEA_MAZE_MCP_HTTP_HOST;
  if (value === undefined || value === "127.0.0.1") return "127.0.0.1";
  if (value === "::1") return "::1";
  throw new TypeError("IDEA_MAZE_MCP_HTTP_HOST must be one of the loopback addresses `127.0.0.1` or `::1`.");
}

function readRequiredSecret(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be configured through the environment or a secret manager.`);
  }
  return value;
}

function readRequiredExpiry(environment: Readonly<Record<string, string | undefined>>): number {
  const value = environment.IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT;
  const match = value === undefined ? null : ISO_TIMESTAMP_WITH_TIMEZONE.exec(value);
  if (!match) {
    throw new TypeError("IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT must be an explicit ISO-8601 timestamp with a timezone.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (month < 1 || month > 12 || day < 1 || day > (daysInMonth ?? 0) || hour > 23 || minute > 59 || second > 59 ||
      offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
    throw new TypeError("IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT is invalid.");
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError("IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT is invalid.");
  return parsed;
}

function readJsonStringList(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: readonly string[],
  maximumItems: number,
): string[] {
  const value = environment[name];
  if (value === undefined) return [...fallback];
  if (Buffer.byteLength(value, "utf8") > MAX_JSON_ENVIRONMENT_VALUE_BYTES) {
    throw new RangeError(`${name} exceeds the bounded JSON configuration size.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new TypeError(`${name} must be a JSON array of strings.`);
  }
  if (!Array.isArray(parsed) || parsed.length > maximumItems || parsed.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TypeError(`${name} must be a JSON array of at most ${maximumItems} non-empty strings.`);
  }
  return parsed as string[];
}

function readInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = parseInteger(environment[name], name);
  const value = parsed ?? fallback;
  if (value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function readOptionalInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = parseInteger(environment[name], name);
  if (parsed === undefined) return undefined;
  if (parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) {
    throw new TypeError(`${name} must be a base-10 integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`${name} must be a safe integer.`);
  return parsed;
}
