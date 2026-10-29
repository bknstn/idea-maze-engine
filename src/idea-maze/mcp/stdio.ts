/** Import-safe stdio adapter. It never chooses or constructs an application. */

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Readable, Writable } from "node:stream";

import type { ResearchApplication } from "../research/contracts.js";
import { createResearchMcpServer } from "./tools.js";

export const MAX_STDIO_MESSAGE_BYTES = 256 * 1024;

export interface StdioResearchServerOptions {
  /** Explicit application/service lifetime owner; called once on close or stdin EOF. */
  onShutdown: () => void | Promise<void>;
  stdin?: Readable;
  stdout?: Writable;
  maxMessageBytes?: number;
}

export interface StdioResearchServerHandle {
  close(): Promise<void>;
}

/**
 * Connect the real MCP SDK stdio transport to an injected research app.
 * Protocol messages alone are written to stdout; this adapter emits no logs.
 */
export async function startStdioResearchServer(
  app: ResearchApplication,
  options: StdioResearchServerOptions,
): Promise<StdioResearchServerHandle> {
  if (typeof options.onShutdown !== "function") {
    throw new TypeError("an explicit onShutdown hook is required");
  }
  const maxMessageBytes = options.maxMessageBytes ?? MAX_STDIO_MESSAGE_BYTES;
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1024 || maxMessageBytes > MAX_STDIO_MESSAGE_BYTES) {
    throw new RangeError(`maxMessageBytes must be an integer between 1024 and ${MAX_STDIO_MESSAGE_BYTES}`);
  }

  const onShutdown = options.onShutdown;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout;
  const server = createResearchMcpServer(app);
  const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize: maxMessageBytes });
  let closing: Promise<void> | undefined;
  let close: () => Promise<void>;
  const onInputEnd = () => {
    void close().catch(() => {
      process.stderr.write("The MCP stdio service could not finish shutting down cleanly.\n");
    });
  };
  close = (): Promise<void> => {
    if (closing) return closing;
    stdin.off("end", onInputEnd);
    closing = (async () => {
      try {
        await server.close();
      } finally {
        await onShutdown();
      }
    })();
    return closing;
  };

  // The SDK transport closes itself on EOF. This separate listener invokes
  // the service lifetime hook without coupling application cancellation to an
  // individual request.
  stdin.once("end", onInputEnd);

  try {
    await server.connect(transport);
  } catch (error) {
    stdin.off("end", onInputEnd);
    await close().catch(() => undefined);
    throw error;
  }
  return { close };
}
