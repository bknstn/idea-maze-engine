/** Synthetic subprocess fixture that composes the real research runtime. */

import { pathToFileURL } from "node:url";

import { createResearchRuntime } from "../../research/runtime.js";
import type { ResearchProviderBindings } from "../../research/ports.js";
import { startStdioResearchServer } from "../stdio.js";

function syntheticProviders(delayMilliseconds: number): ResearchProviderBindings {
  return {
    model: {
      availability: "available",
      adapter: "synthetic-fixture",
      provider: {
        async generateJson<T>() {
          return { value: { candidates: [] } as T, usage: { inputTokens: 1, outputTokens: 1, costMicros: null } };
        },
      },
    },
    search: {
      availability: "available",
      adapter: "synthetic-fixture",
      provider: {
        async search({ signal }) {
          if (delayMilliseconds > 0) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, delayMilliseconds);
              const abort = () => {
                clearTimeout(timer);
                reject(new DOMException("Synthetic search cancelled", "AbortError"));
              };
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            });
          }
          return { results: [], requestsUsed: 1, costMicros: null };
        },
      },
    },
    originalSourceReader: {
      availability: "available",
      adapter: "synthetic-fixture",
      provider: {
        async fetchOriginal() {
          throw new Error("Synthetic no-result search must not fetch an original.");
        },
      },
    },
  };
}

async function main(): Promise<void> {
  const workspaceRoot = process.env.IDEA_MAZE_HOME;
  if (!workspaceRoot) throw new TypeError("An isolated synthetic workspace is required.");
  const rawDelay = process.env.IDEA_MAZE_TEST_SEARCH_DELAY_MS ?? "0";
  if (!/^(?:0|[1-9][0-9]{0,3})$/u.test(rawDelay) || Number(rawDelay) > 5000) {
    throw new TypeError("The synthetic provider delay is outside its test bound.");
  }
  const lifetime = new AbortController();
  const runtime = createResearchRuntime({
    workspaceRoot,
    environment: process.env,
    providers: syntheticProviders(Number(rawDelay)),
    serviceLifetimeSignal: lifetime.signal,
  });
  let handle: Awaited<ReturnType<typeof startStdioResearchServer>> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (closing) return closing;
    lifetime.abort();
    closing = handle ? handle.close() : runtime.shutdown();
    return closing;
  };
  process.once("SIGINT", () => { void close().catch(() => { process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void close().catch(() => { process.exitCode = 1; }); });
  handle = await startStdioResearchServer(runtime.application, { onShutdown: runtime.shutdown });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write("The synthetic runtime stdio fixture failed to start.\n");
    process.exitCode = 1;
  });
}
