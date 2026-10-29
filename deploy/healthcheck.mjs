import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "::1"];
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;
const HEALTH_PATH = "/healthz";
const HEALTH_TIMEOUT_MS = 2_000;

export function createHealthProbe(environment = process.env) {
  const bindHost = readBindHost(environment.IDEA_MAZE_MCP_HTTP_HOST);
  const port = readPort(environment.IDEA_MAZE_MCP_HTTP_PORT);
  const allowedHosts = readStringList(environment.IDEA_MAZE_MCP_ALLOWED_HOSTS, DEFAULT_ALLOWED_HOSTS, 64, true)
    .map(normalizeAllowedHost);
  const trustedPeers = readStringList(environment.IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS, [], 32, false)
    .map(normalizePeerAddress);
  if (new Set(allowedHosts).size !== allowedHosts.length || new Set(trustedPeers).size !== trustedPeers.length) {
    throw new TypeError("HTTP health configuration is invalid.");
  }

  const bindAuthority = formatAuthority(bindHost);
  const allowedHost = allowedHosts[0];
  const headers = {
    host: `${formatAuthority(allowedHost)}:${port}`,
  };
  if (trustedPeers.includes(normalizePeerAddress(bindHost))) {
    headers["x-forwarded-proto"] = "https";
  }

  return Object.freeze({
    url: `http://${bindAuthority}:${port}${HEALTH_PATH}`,
    headers: Object.freeze(headers),
  });
}

export async function checkHealth({ environment = process.env, requestImplementation = httpRequest } = {}) {
  try {
    const probe = createHealthProbe(environment);
    const statusCode = await new Promise((resolveResponse, rejectRequest) => {
      const request = requestImplementation(probe.url, { method: "GET", headers: probe.headers }, (response) => {
        response.resume();
        response.once("end", () => resolveResponse(response.statusCode));
      });
      request.setTimeout(HEALTH_TIMEOUT_MS, () => request.destroy(new Error("Health probe timed out.")));
      request.once("error", rejectRequest);
      request.end();
    });
    return statusCode === 200;
  } catch {
    return false;
  }
}

function readBindHost(value) {
  if (value === undefined || value === "127.0.0.1") return "127.0.0.1";
  if (value === "::1") return "::1";
  throw new TypeError("HTTP health configuration is invalid.");
}

function readPort(value) {
  if (value === undefined) return 8787;
  if (!/^(?:[1-9]\d{0,4})$/u.test(value)) throw new TypeError("HTTP health configuration is invalid.");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) throw new TypeError("HTTP health configuration is invalid.");
  return port;
}

function readStringList(value, fallback, maximumItems, requireNonEmpty) {
  if (value === undefined) return [...fallback];
  if (Buffer.byteLength(value, "utf8") > 16 * 1024) throw new TypeError("HTTP health configuration is invalid.");
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("HTTP health configuration is invalid.");
  }
  if (!Array.isArray(parsed) || parsed.length > maximumItems || (requireNonEmpty && parsed.length === 0) ||
      parsed.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new TypeError("HTTP health configuration is invalid.");
  }
  return parsed;
}

function normalizeAllowedHost(value) {
  if (value.length > 253 || value.trim() !== value || /[\s/@#?]/u.test(value)) {
    throw new TypeError("HTTP health configuration is invalid.");
  }
  const bracketed = value.startsWith("[") && value.endsWith("]");
  const host = bracketed ? value.slice(1, -1) : value;
  if (isIP(host) === 6) return host.toLowerCase();
  const normalized = host.toLowerCase().replace(/\.$/u, "");
  if (!HOSTNAME_PATTERN.test(normalized) && isIP(normalized) !== 4) {
    throw new TypeError("HTTP health configuration is invalid.");
  }
  return normalized;
}

function normalizePeerAddress(value) {
  if (isIP(value) === 0) throw new TypeError("HTTP health configuration is invalid.");
  const normalized = value.toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function formatAuthority(host) {
  return isIP(host) === 6 ? `[${host}]` : host;
}

if (isMainModule()) {
  process.exitCode = await checkHealth() ? 0 : 1;
}

function isMainModule() {
  return process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}
