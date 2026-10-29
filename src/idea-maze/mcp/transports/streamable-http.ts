/** Loopback-only stateless Streamable HTTP adapter for the shared app port. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  NodeStreamableHTTPServerTransport,
} from "@modelcontextprotocol/node";

import type { ResearchApplication } from "../../research/contracts.js";
import { createResearchMcpServer, snapshotResearchApplication } from "../tools.js";
import { getSingleRawHeader, isHttpSecurityConfiguration, type HttpSecurityConfiguration } from "../security/http-validation.js";

export const DEFAULT_HTTP_REQUEST_BODY_BYTES = 256 * 1024;
export const MAX_HTTP_REQUEST_BODY_BYTES = 1024 * 1024;
export const DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS = 1500;
export const MAX_HTTP_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_MCP_HTTP_PATH = "/mcp";
export const DEFAULT_MCP_HTTP_HEALTH_PATH = "/healthz";

export type LoopbackBindHost = "127.0.0.1" | "::1";

/**
 * Optional final deny-only extension. It runs only after the mandatory T18
 * security policy has authenticated and admitted a request.
 */
export type AdditionalHttpRequestGuard = (
  request: IncomingMessage,
  response: ServerResponse,
) => boolean | Promise<boolean>;

export interface StreamableHttpResearchOptions {
  app: ResearchApplication;
  port: number;
  /** Defaults to the policy's loopback address. Remote bind addresses are intentionally unrepresentable. */
  host?: LoopbackBindHost;
  path?: string;
  maxRequestBodyBytes?: number;
  /** Explicit credentials, Host/Origin policy, rate bounds, and proxy trust. */
  security: HttpSecurityConfiguration;
  additionalRequestGuard?: AdditionalHttpRequestGuard;
  /** Total bound for graceful drain, forced close, and the shutdown hook. */
  shutdownTimeoutMilliseconds?: number;
  /** Called only when the returned service handle is explicitly closed. */
  onShutdown: () => void | Promise<void>;
}

export interface StreamableHttpResearchService {
  readonly url: URL;
  close(): Promise<void>;
}

/**
 * Listen on an IPv4/IPv6 loopback address only, with mandatory T18 security.
 * A new SDK protocol server and
 * stateless HTTP transport are made per request, while every handler closes
 * over the exact same injected application instance and service lifetime.
 */
export async function listenStreamableHttpResearchServer(
  options: StreamableHttpResearchOptions,
): Promise<StreamableHttpResearchService> {
  if (typeof options.onShutdown !== "function") {
    throw new TypeError("an explicit onShutdown hook is required");
  }
  const requestedHost: unknown = options.host;
  if (requestedHost !== undefined && requestedHost !== "127.0.0.1" && requestedHost !== "::1") {
    throw new TypeError("HTTP MCP may bind only to the IPv4 or IPv6 loopback address");
  }
  if (!isHttpSecurityConfiguration(options.security)) {
    throw new TypeError("an explicit validated HTTP security policy is required");
  }
  if (requestedHost !== undefined && requestedHost !== options.security.bindHost) {
    throw new TypeError("HTTP bind host must match the validated security policy");
  }
  const port = options.port;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }
  const path = options.path ?? DEFAULT_MCP_HTTP_PATH;
  if (!/^\/[A-Za-z0-9/_-]{0,127}$/u.test(path) || path.includes("//") || path.endsWith("/")) {
    throw new TypeError("path must be a simple absolute route path");
  }
  const requestedBodyLimit = options.maxRequestBodyBytes ?? options.security.maxRequestBodyBytes;
  if (!Number.isSafeInteger(requestedBodyLimit) || requestedBodyLimit < 1024 || requestedBodyLimit > options.security.maxRequestBodyBytes || requestedBodyLimit > MAX_HTTP_REQUEST_BODY_BYTES) {
    throw new RangeError(`maxRequestBodyBytes must be an integer between 1024 and ${MAX_HTTP_REQUEST_BODY_BYTES}`);
  }
  const maxRequestBodyBytes = requestedBodyLimit;
  const shutdownTimeoutMilliseconds = options.shutdownTimeoutMilliseconds ?? DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(shutdownTimeoutMilliseconds) || shutdownTimeoutMilliseconds < 100 || shutdownTimeoutMilliseconds > MAX_HTTP_SHUTDOWN_TIMEOUT_MS) {
    throw new RangeError(`shutdownTimeoutMilliseconds must be an integer between 100 and ${MAX_HTTP_SHUTDOWN_TIMEOUT_MS}`);
  }
  if (options.additionalRequestGuard !== undefined && typeof options.additionalRequestGuard !== "function") {
    throw new TypeError("additionalRequestGuard must be a function when supplied");
  }

  // Snapshot all configurable references before opening the listener. Caller
  // mutation after this point cannot replace the app, policy, or shutdown hook.
  const app = snapshotResearchApplication(options.app);
  const additionalRequestGuard = options.additionalRequestGuard;
  const security = options.security;
  const onShutdown = options.onShutdown;
  const host = (requestedHost ?? security.bindHost) as LoopbackBindHost;
  let isClosing = false;
  const activeProtocolServers = new Set<ReturnType<typeof createResearchMcpServer>>();

  const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (isClosing) {
      sendJson(response, 503, { error: "Service is shutting down." });
      return;
    }

    const healthCheck = request.url === DEFAULT_MCP_HTTP_HEALTH_PATH && (request.method === "GET" || request.method === "HEAD");
    const decision = healthCheck
      ? security.authorizeHealthCheck(request)
      : security.authorize(request);
    if (decision.allowed === false) {
      const headers: Record<string, string> = {};
      if (decision.status === 401) headers["WWW-Authenticate"] = "Bearer";
      if (decision.status === 429) headers["Retry-After"] = String(decision.retryAfterSeconds ?? 1);
      sendJson(response, decision.status, { error: safeHttpMessage(decision.status) }, headers);
      return;
    }

    if (additionalRequestGuard) {
      const allowed = await additionalRequestGuard(request, response);
      if (!allowed) {
        if (!response.headersSent) {
          sendJson(response, 403, { error: "Forbidden" });
        }
        return;
      }
    }
    if (isClosing) {
      sendJson(response, 503, { error: "Service is shutting down." });
      return;
    }
    const declaredLength = getSingleRawHeader(request, "content-length");
    if (declaredLength.kind === "invalid") {
      sendJson(response, 400, { error: "Invalid request." });
      return;
    }
    if (declaredLength.kind === "one") {
      if (!/^(?:0|[1-9][0-9]{0,12})$/u.test(declaredLength.value)) {
        sendJson(response, 400, { error: "Invalid request." });
        return;
      }
      if (Number(declaredLength.value) > maxRequestBodyBytes) {
        sendJson(response, 413, { error: "Request body is too large." });
        return;
      }
    }
    const transferEncoding = getSingleRawHeader(request, "transfer-encoding");
    if (transferEncoding.kind === "invalid" || (transferEncoding.kind === "one" && transferEncoding.value.toLowerCase() !== "chunked")) {
      sendJson(response, 400, { error: "Invalid request." });
      return;
    }
    if (transferEncoding.kind === "one" && declaredLength.kind === "one") {
      sendJson(response, 400, { error: "Invalid request." });
      return;
    }
    const hasBody = (declaredLength.kind === "one" && Number(declaredLength.value) > 0) || transferEncoding.kind === "one";
    if (request.method !== "POST" && hasBody) {
      sendJson(response, 400, { error: "Invalid request." });
      return;
    }
    if (healthCheck) {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": "15",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : '{"status":"ok"}');
      return;
    }
    if (request.url !== path) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    // Stateless per-request protocol state. No request/session owns the app,
    // database, run coordinator, or provider cancellation signal.
    const mcpServer = createResearchMcpServer(app);
    activeProtocolServers.add(mcpServer);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: maxRequestBodyBytes,
      keepAliveMs: 0,
    });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 500, { error: "The MCP request could not be completed." });
      }
    } finally {
      // Closing an individual protocol server must never close the shared app.
      activeProtocolServers.delete(mcpServer);
      await mcpServer.close().catch(() => undefined);
    }
  };

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) {
        sendJson(response, 500, { error: "The MCP request could not be completed." });
      }
    });
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.timeout = 20_000;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("The loopback HTTP server did not report a TCP address.");
  }
  const actualAddress = address as AddressInfo;
  const urlHost = host === "::1" ? `[${host}]` : host;
  const url = new URL(`http://${urlHost}:${actualAddress.port}${path}`);

  let closing: Promise<void> | undefined;
  return {
    url,
    close() {
      if (closing) return closing;
      isClosing = true;
      const deadline = Date.now() + shutdownTimeoutMilliseconds;
      const shutdown = settle(invokeShutdown(onShutdown));
      const protocolServers = [...activeProtocolServers];
      const protocolClose = settle(Promise.all(protocolServers.map((activeServer) => activeServer.close().catch(() => undefined))));
      const httpClose = settle(closeServer(server));
      closing = finishShutdown({
        server,
        protocolServers,
        protocolClose,
        httpClose,
        shutdown,
        deadline,
      });
      return closing;
    },
  };
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function invokeShutdown(hook: () => void | Promise<void>): Promise<void> {
  try {
    return Promise.resolve(hook());
  } catch (error) {
    return Promise.reject(error);
  }
}

async function finishShutdown(input: {
  server: Server;
  protocolServers: ReturnType<typeof createResearchMcpServer>[];
  protocolClose: Promise<Settled<unknown>>;
  httpClose: Promise<Settled<void>>;
  shutdown: Promise<Settled<void>>;
  deadline: number;
}): Promise<void> {
  const gracefulWindow = Math.max(1, Math.floor((input.deadline - Date.now()) / 2));
  await waitUntilSettled(Promise.all([input.protocolClose, input.httpClose]), gracefulWindow);

  // Stop active per-request protocol transports and force any HTTP sockets
  // still holding a handler open. App work has already received service-level
  // shutdown; disconnecting these requests does not pass a cancellation signal
  // into the application port.
  input.server.closeAllConnections();
  for (const protocolServer of input.protocolServers) {
    void protocolServer.close().catch(() => undefined);
  }

  const remaining = input.deadline - Date.now();
  const [protocolResult, httpResult, shutdownResult] = await Promise.all([
    outcomeWithin(input.protocolClose, remaining),
    outcomeWithin(input.httpClose, remaining),
    outcomeWithin(input.shutdown, remaining),
  ]);

  if (httpResult?.ok === false) throw httpResult.error;
  if (protocolResult?.ok === false) throw protocolResult.error;
  if (shutdownResult?.ok === false) throw shutdownResult.error;
  if (!shutdownResult) throw new Error("The research service shutdown hook did not settle before the shutdown deadline.");
  if (!httpResult || !protocolResult) throw new Error("The HTTP MCP service did not finish closing before the shutdown deadline.");
}

async function waitUntilSettled<T>(promise: Promise<T>, milliseconds: number): Promise<boolean> {
  if (milliseconds <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function outcomeWithin<T>(promise: Promise<Settled<T>>, milliseconds: number): Promise<Settled<T> | undefined> {
  if (milliseconds <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sendJson(response: ServerResponse, status: number, body: Record<string, string>, headers: Record<string, string> = {}): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function safeHttpMessage(status: number): string {
  if (status === 401) return "Authentication required.";
  if (status === 400) return "Invalid request.";
  if (status === 429) return "Too many requests.";
  if (status === 503) return "Service unavailable.";
  return "Forbidden.";
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}
