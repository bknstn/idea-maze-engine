import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createResearchRuntime } from "../research/runtime.js";
import { formatResearchCliHelp, isResearchCliHelp, runResearchCli } from "./research-cli.js";

/** Bind the real single-workspace runtime only at the executable boundary. */
export async function runResearchCliProcess(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (isResearchCliHelp(argv)) {
    process.stdout.write(formatResearchCliHelp());
    process.exitCode = 0;
    return;
  }

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);

  let runtime: ReturnType<typeof createResearchRuntime> | undefined;
  try {
    runtime = createResearchRuntime();
    process.exitCode = await runResearchCli(argv, {
      app: runtime.application,
      stdin: process.stdin,
      stdout: (text) => { process.stdout.write(text); },
      stderr: (text) => { process.stderr.write(text); },
      signal: controller.signal,
    });
  } catch {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "1.0.0",
      error: {
        code: "INTERNAL_ERROR",
        message: "The research runtime could not be started.",
        retryable: false,
        details: { kind: "internal" },
      },
    }, null, 2)}\n`);
    process.stderr.write("Research CLI failed to initialize (INTERNAL_ERROR).\n");
    process.exitCode = 70;
  } finally {
    try {
      await runtime?.shutdown();
    } catch {
      process.stderr.write("Research runtime shutdown failed (INTERNAL_ERROR).\n");
      if (process.exitCode === 0 || process.exitCode === undefined) process.exitCode = 70;
    } finally {
      process.off("SIGINT", onSigint);
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await runResearchCliProcess();
}
