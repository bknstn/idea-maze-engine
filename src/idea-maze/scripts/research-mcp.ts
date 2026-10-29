/** Primary HTTP executable and optional local stdio MCP entrypoint. */

import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";

import { createResearchRuntime } from "../research/runtime.js";
import { startStdioResearchServer } from "../mcp/stdio.js";
import { createResearchMcpHttpEnvironmentConfiguration, readResearchMcpTransport } from "../mcp/security/http-config.js";
import { listenStreamableHttpResearchServer } from "../mcp/transports/streamable-http.js";

export interface ResearchMcpProcessOptions {
  /** Immutable process/secret-manager configuration snapshot. */
  environment?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
}

export interface ResearchMcpProcessHandle {
  /** Present for HTTP mode so an embedding host can observe its loopback URL. */
  readonly url?: URL;
  close(): Promise<void>;
}

/**
 * Compose one actual research runtime and attach a single MCP transport. The
 * transport never builds application logic, opens a second database, or owns
 * per-client run cancellation.
 */
export async function startResearchMcpProcess(
  options: ResearchMcpProcessOptions = {},
): Promise<ResearchMcpProcessHandle> {
  const environment = Object.freeze({ ...(options.environment ?? process.env) }) as NodeJS.ProcessEnv;
  const selectedTransport = readResearchMcpTransport(environment);
  // Validate all HTTP credentials and trust policy before opening the database.
  const httpConfiguration = selectedTransport === "http"
    ? createResearchMcpHttpEnvironmentConfiguration(environment)
    : undefined;
  const lifetime = new AbortController();
  const runtime = createResearchRuntime({ environment, serviceLifetimeSignal: lifetime.signal });

  let transportClose: (() => Promise<void>) | undefined;
  let serviceUrl: URL | undefined;
  let closing: Promise<void> | undefined;
  let runtimeShutdownStarted = false;
  let signalHandlersAttached = false;
  let removeSignalHandlers: () => void = () => {};
  const close = (): Promise<void> => {
    if (closing) return closing;
    lifetime.abort();
    closing = (async () => {
      try {
        if (transportClose) await transportClose();
        else await runtime.shutdown();
      } finally {
        removeSignalHandlers();
      }
    })();
    return closing;
  };
  const onSignal = () => {
    void close().catch(() => {
      process.stderr.write("Research MCP service shutdown failed.\n");
      process.exitCode = 1;
    });
  };
  removeSignalHandlers = () => {
    if (!signalHandlersAttached) return;
    signalHandlersAttached = false;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  const shutdownRuntime = () => {
    runtimeShutdownStarted = true;
    if (!lifetime.signal.aborted) lifetime.abort();
    removeSignalHandlers();
    return runtime.shutdown();
  };

  try {
    if (selectedTransport === "stdio") {
      const server = await startStdioResearchServer(runtime.application, {
        onShutdown: shutdownRuntime,
        ...(options.stdin ? { stdin: options.stdin } : {}),
        ...(options.stdout ? { stdout: options.stdout } : {}),
      });
      transportClose = () => server.close();
    } else if (httpConfiguration) {
      const service = await listenStreamableHttpResearchServer({
        app: runtime.application,
        host: httpConfiguration.host,
        port: httpConfiguration.port,
        security: httpConfiguration.security,
        onShutdown: shutdownRuntime,
      });
      transportClose = () => service.close();
      serviceUrl = service.url;
      process.stderr.write(`Research MCP HTTP service listening at ${service.url.href}\n`);
    } else {
      throw new Error("The HTTP transport configuration is unavailable.");
    }
  } catch {
    runtimeShutdownStarted = true;
    lifetime.abort();
    removeSignalHandlers();
    await runtime.shutdown().catch(() => undefined);
    throw new Error("Research MCP service could not start.");
  }

  if (!runtimeShutdownStarted) {
    signalHandlersAttached = true;
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  return Object.freeze({ ...(serviceUrl ? { url: serviceUrl } : {}), close });
}

async function main(): Promise<void> {
  await startResearchMcpProcess();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("Research MCP service could not start. Check its environment configuration.\n");
    process.exitCode = 1;
  });
}
