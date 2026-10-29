import {
  RESEARCH_SCHEMA_VERSION,
  type CancelRunInput,
  type CancelRunResult,
  type ResearchApplication,
  type ResearchFailure,
  type ResearchResponse,
  type RunExecutionStatus,
  type RunStatusResult,
  type StartRunInput,
  type StartRunResult,
} from "../research/contracts.js";

const MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_CANCEL_CLEANUP_TIMEOUT_MS = 10 * 1000;
const MIN_POLL_INTERVAL_MS = 50;
const MAX_POLL_INTERVAL_MS = 30_000;

export type ResearchCliCommand =
  | "capabilities"
  | "case-create"
  | "case-get"
  | "case-update"
  | "plan"
  | "start"
  | "status"
  | "result"
  | "cancel";

export interface ResearchCliDependencies {
  app: ResearchApplication;
  stdin: AsyncIterable<string | Uint8Array>;
  stdout: (text: string) => void | Promise<void>;
  stderr: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  waitTimeoutMs?: number;
  operationTimeoutMs?: number;
  cancelCleanupTimeoutMs?: number;
  createIdempotencyKey?: () => string;
}

interface ParsedArguments {
  command: ResearchCliCommand | "help";
  format: "json" | "markdown" | undefined;
  pollIntervalMs: number;
  waitTimeoutMs: number;
}

const EXIT = {
  success: 0,
  validation: 2,
  notFound: 3,
  conflict: 4,
  busy: 5,
  providerUnavailable: 6,
  limitExceeded: 7,
  forbidden: 8,
  rateLimited: 9,
  usage: 64,
  input: 65,
  timeout: 124,
  interrupted: 130,
  internal: 70,
} as const;

const TERMINAL_STATUSES = new Set<RunExecutionStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const HELP = `Idea Maze hypothesis research CLI

Usage:
  npm run --silent idea:research:cli -- <command> [options] < request.json

Commands (each calls the shared ResearchApplication):
  capabilities   Read provider capabilities and hard limits (no stdin required)
  case-create    Create a research case
  case-get       Read the latest or a historical case revision
  case-update    Append a case and/or hypothesis revision
  plan           Validate or generate a bounded research plan
  start          Start a run and wait for a terminal state; Ctrl-C requests cancellation
  status         Read run execution status
  result         Read a bounded result page
  cancel         Explicitly request run cancellation

Input:
  Provide the operation's JSON object on stdin. Idea text is never accepted as a shell argument.
  Output is one JSON envelope on stdout. Diagnostics contain no input or provider details.

Options:
  --format json|markdown      For result, or for the result page returned by start
  --poll-interval-ms <n>      Start polling interval (${MIN_POLL_INTERVAL_MS}..${MAX_POLL_INTERVAL_MS})
  --wait-timeout-ms <n>       Start wait deadline (100..${DEFAULT_WAIT_TIMEOUT_MS})
  -h, --help                  Show this help and synthetic example

Exit codes:
  0 success, 2 validation, 3 not found, 4 revision/idempotency conflict, 5 busy,
  6 provider unavailable, 7 limit exceeded, 8 access denied, 9 rate limited,
  64 command usage, 65 stdin input, 70 internal/run failure, 124 wait timeout,
  130 cancelled by Ctrl-C

Synthetic example:
  printf '%s' '{"idempotencyKey":"demo-case-create-0001","intake":{"ideaSummary":"A sample workflow helper","targetUser":"Independent tutors","problem":"Session notes take time","proposedSolution":"A simple structured note template"},"hypotheses":[{"claim":"Tutors spend time rewriting session notes"}]}' | npm run --silent idea:research:cli -- case-create
`;

/** Help is pure so an executable can answer it without opening a workspace. */
export function isResearchCliHelp(argv: readonly string[]): boolean {
  return argv.length === 0 || argv.some((token) => token === "--help" || token === "-h");
}

export function formatResearchCliHelp(): string {
  return HELP;
}

/**
 * Run one transport-neutral CLI command against an injected shared application.
 * The executable entrypoint binds this core to a real workspace runtime.
 */
export async function runResearchCli(
  argv: readonly string[],
  dependencies: ResearchCliDependencies,
): Promise<number> {
  let args: ParsedArguments;
  try {
    args = parseArguments(argv, dependencies);
  } catch (error) {
    const message = error instanceof CliArgumentError ? error.message : "Invalid command line.";
    await writeJson(dependencies.stdout, validationFailure("cli"));
    await dependencies.stderr(`CLI usage error: ${message}\n`);
    return EXIT.usage;
  }

  if (args.command === "help") {
    await dependencies.stdout(formatResearchCliHelp());
    return EXIT.success;
  }

  if (dependencies.signal?.aborted) {
    await writeJson(dependencies.stdout, internalFailure());
    await dependencies.stderr("Interrupted before the research operation started.\n");
    return EXIT.interrupted;
  }

  let input: Record<string, unknown> = {};
  if (args.command !== "capabilities") {
    try {
      input = await readJsonInput(dependencies.stdin, dependencies.signal);
    } catch (error) {
      if (error instanceof CliInterrupted || dependencies.signal?.aborted) {
        await writeJson(dependencies.stdout, internalFailure());
        await dependencies.stderr("Interrupted while reading stdin; no research operation was started.\n");
        return EXIT.interrupted;
      }
      const message = error instanceof CliInputError ? error.message : "Input must be one JSON object on stdin.";
      await writeJson(dependencies.stdout, validationFailure("stdin"));
      await dependencies.stderr(`CLI input error: ${message}\n`);
      return EXIT.input;
    }
  }

  if (dependencies.signal?.aborted) {
    await writeJson(dependencies.stdout, internalFailure());
    await dependencies.stderr("Interrupted before the research operation started.\n");
    return EXIT.interrupted;
  }

  try {
    switch (args.command) {
      case "capabilities":
        return await runApplicationCall(dependencies, () => dependencies.app.capabilities());
      case "case-create":
        return await runApplicationCall(dependencies, () => dependencies.app.createCase(input as never));
      case "case-get":
        return await runApplicationCall(dependencies, () => dependencies.app.getCase(input as never));
      case "case-update":
        return await runApplicationCall(dependencies, () => dependencies.app.updateCase(input as never));
      case "plan":
        return await runApplicationCall(dependencies, () => dependencies.app.plan(input as never));
      case "status":
        return await runApplicationCall(dependencies, () => dependencies.app.status(input as never));
      case "result": {
        const resultInput = { ...input, ...(args.format ? { format: args.format } : {}) };
        return await runApplicationCall(dependencies, () => dependencies.app.result(resultInput as never));
      }
      case "cancel":
        // A cancel command itself must reach the durable application boundary
        // before the process asks the runtime to shut down.
        return await runApplicationCall(
          dependencies,
          () => dependencies.app.cancel(input as never),
          { timeoutMs: dependencies.cancelCleanupTimeoutMs ?? DEFAULT_CANCEL_CLEANUP_TIMEOUT_MS, signal: undefined },
        );
      case "start":
        return await runStart(input as unknown as StartRunInput, args, dependencies);
    }
  } catch {
    const response = internalFailure();
    await writeJson(dependencies.stdout, response);
    await dependencies.stderr("Research operation failed (INTERNAL_ERROR).\n");
    return EXIT.internal;
  }
}

async function runApplicationCall<T>(
  dependencies: ResearchCliDependencies,
  invoke: () => Promise<ResearchResponse<T>>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<number> {
  const now = dependencies.now ?? Date.now;
  const signal = Object.prototype.hasOwnProperty.call(options, "signal") ? options.signal : dependencies.signal;
  const outcome = await awaitBounded(
    invoke,
    dependencies,
    now() + (options.timeoutMs ?? dependencies.operationTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    signal,
  );
  if (outcome.kind === "aborted") {
    await writeJson(dependencies.stdout, internalFailure());
    await dependencies.stderr("Interrupted while waiting for the research operation.\n");
    return EXIT.interrupted;
  }
  if (outcome.kind === "timeout") {
    await writeJson(dependencies.stdout, timeoutFailure());
    await dependencies.stderr("Research operation exceeded the CLI wait deadline.\n");
    return EXIT.timeout;
  }
  const response = outcome.kind === "value" ? outcome.value : internalFailure();
  await writeJson(dependencies.stdout, response);
  if ("error" in response) {
    await dependencies.stderr(`Research operation failed (${response.error.code}).\n`);
    return exitCodeForResearchError(response);
  }
  return EXIT.success;
}

async function runStart(
  input: StartRunInput,
  args: ParsedArguments,
  dependencies: ResearchCliDependencies,
): Promise<number> {
  const now = dependencies.now ?? Date.now;
  const startDeadline = now() + (dependencies.operationTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  // start returns the run ID needed for explicit cancellation. Do not abandon
  // this short ownership handoff on SIGINT; once it resolves, check the CLI
  // signal and cancel the run before runtime shutdown begins.
  const startOutcome = await awaitBounded(
    () => dependencies.app.start(input),
    dependencies,
    startDeadline,
    undefined,
    dependencies.signal,
  );
  if (startOutcome.kind === "aborted") {
    await writeJson(dependencies.stdout, internalFailure());
    await dependencies.stderr("Interrupted before the research run started.\n");
    return EXIT.interrupted;
  }
  if (startOutcome.kind === "timeout") {
    await writeJson(dependencies.stdout, timeoutFailure());
    await dependencies.stderr("Could not obtain a run ID before the CLI start deadline.\n");
    return EXIT.timeout;
  }
  if (startOutcome.kind !== "value") {
    await writeJson(dependencies.stdout, internalFailure());
    await dependencies.stderr("Research start failed (INTERNAL_ERROR).\n");
    return EXIT.internal;
  }
  const started = startOutcome.value;
  if ("error" in started) {
    await writeJson(dependencies.stdout, started);
    await dependencies.stderr(`Research operation failed (${started.error.code}).\n`);
    return exitCodeForResearchError(started);
  }

  const start = started.data;
  const deadline = now() + args.waitTimeoutMs;
  let lastStatus: RunStatusResult | null = null;
  let lastPollFailure: ResearchFailure | null = null;
  let stopReason: "interrupted" | "timeout" | "status_error" | null = null;
  const maxPolls = Math.ceil(args.waitTimeoutMs / args.pollIntervalMs) + 2;
  let pollCount = 0;

  while (true) {
    if (dependencies.signal?.aborted) {
      stopReason = "interrupted";
      break;
    }
    if (now() >= deadline) {
      stopReason = "timeout";
      break;
    }
    if (pollCount >= maxPolls) {
      stopReason = "timeout";
      break;
    }
    pollCount += 1;

    const statusOutcome = await awaitBounded(
      () => dependencies.app.status({ runId: start.runId }),
      dependencies,
      deadline,
      dependencies.signal,
    );
    if (statusOutcome.kind === "aborted" || dependencies.signal?.aborted) {
      stopReason = "interrupted";
      break;
    }
    if (statusOutcome.kind === "timeout") {
      stopReason = "timeout";
      break;
    }
    const statusResponse = statusOutcome.kind === "value" ? statusOutcome.value : internalFailure();
    if ("error" in statusResponse) {
      if (!statusResponse.error.retryable) {
        lastPollFailure = statusResponse;
        stopReason = "status_error";
        break;
      }
      lastPollFailure = statusResponse;
    } else {
      lastPollFailure = null;
      lastStatus = statusResponse.data;
      if (TERMINAL_STATUSES.has(lastStatus.status)) break;
    }

    const sleepOutcome = await boundedSleep(
      dependencies,
      Math.min(args.pollIntervalMs, Math.max(0, deadline - now())),
      deadline,
      dependencies.signal,
    );
    if (sleepOutcome.kind === "aborted" || dependencies.signal?.aborted) {
      stopReason = "interrupted";
      break;
    }
    if (sleepOutcome.kind === "timeout") {
      stopReason = "timeout";
      break;
    }
    if (sleepOutcome.kind === "error") {
      lastPollFailure = internalFailure();
      stopReason = "status_error";
      break;
    }
  }

  let cancellation: CancelRunResult | null = null;
  let cleanupDeadline: number | null = null;
  if (stopReason) {
    cleanupDeadline = now() + (dependencies.cancelCleanupTimeoutMs ?? DEFAULT_CANCEL_CLEANUP_TIMEOUT_MS);
    cancellation = await requestCancellation(start.runId, dependencies, cleanupDeadline);
    const drained = await drainCancellation(start.runId, dependencies, cleanupDeadline);
    if (drained.status) lastStatus = drained.status;
    if (drained.response && "error" in drained.response) lastPollFailure = drained.response;
  }

  const terminal = lastStatus && TERMINAL_STATUSES.has(lastStatus.status);
  if (!terminal) {
    const incompleteResponse = (lastStatus
      ? responseFromStatus(lastStatus)
      : lastPollFailure ?? internalFailure()) as ResearchResponse<unknown>;
    await writeJson(dependencies.stdout, incompleteResponse);
    const observed = lastStatus?.status ?? "unavailable";
    const cancelState = cancellation?.cancellationRequested
      ? "cancellation was accepted"
      : cancellation
        ? "the service returned without accepting a new cancellation"
        : "no successful cancellation response was received";
    await dependencies.stderr(`Cleanup incomplete: last observed status ${observed}; ${cancelState}. Run ${start.runId}.\n`);
    if (stopReason === "interrupted") return EXIT.interrupted;
    if (stopReason === "timeout") return EXIT.timeout;
    return exitCodeForResearchError(lastPollFailure ?? internalFailure());
  }

  const resultDeadline = cleanupDeadline ?? deadline;
  const resultOutcome = await awaitBounded(
    () => dependencies.app.result({ runId: start.runId, limit: 100, format: args.format ?? "json" }),
    dependencies,
    resultDeadline,
    cleanupDeadline === null ? dependencies.signal : undefined,
  );
  let resultResponse: ResearchResponse<unknown>;
  if (resultOutcome.kind === "value") resultResponse = resultOutcome.value;
  else if (resultOutcome.kind === "error") resultResponse = internalFailure();
  else if (resultOutcome.kind === "aborted") resultResponse = internalFailure();
  else resultResponse = timeoutFailure();
  await writeJson(dependencies.stdout, resultResponse);
  if ("error" in resultResponse) {
    await dependencies.stderr(`Result retrieval failed (${resultResponse.error.code}); last observed status ${lastStatus?.status ?? "unavailable"}; run ${start.runId}.\n`);
    if (stopReason === "interrupted") return EXIT.interrupted;
    if (stopReason === "timeout") return EXIT.timeout;
    if (resultOutcome.kind === "timeout") return EXIT.timeout;
    if (resultOutcome.kind === "aborted") return EXIT.interrupted;
    return exitCodeForResearchError(resultResponse);
  }
  if (stopReason === "interrupted") {
    const cancelText = cancellation?.cancellationRequested ? "cancellation was accepted" : "cancellation was not confirmed";
    await dependencies.stderr(`Interrupted: ${cancelText}; terminal status ${lastStatus?.status}; run ${start.runId}.\n`);
    return EXIT.interrupted;
  }
  if (stopReason === "timeout") {
    const cancelText = cancellation?.cancellationRequested ? "cancellation was accepted" : "cancellation was not confirmed";
    await dependencies.stderr(`Wait deadline elapsed: ${cancelText}; terminal status ${lastStatus?.status}; run ${start.runId}.\n`);
    return EXIT.timeout;
  }
  if (stopReason === "status_error") {
    await dependencies.stderr(`Research status failed while run ${start.runId} was being cancelled.\n`);
    return exitCodeForResearchError(lastPollFailure ?? internalFailure());
  }
  await dependencies.stderr(`Run ${start.runId} reached terminal status ${lastStatus?.status}.\n`);
  if (lastStatus?.status === "failed" || lastStatus?.status === "interrupted") return EXIT.internal;
  if (lastStatus?.status === "cancelled") return EXIT.interrupted;
  return EXIT.success;
}

async function requestCancellation(
  runId: string,
  dependencies: ResearchCliDependencies,
  deadline: number,
): Promise<CancelRunResult | null> {
  const createKey = dependencies.createIdempotencyKey ?? defaultIdempotencyKey;
  const request: CancelRunInput = { runId, idempotencyKey: createKey() };
  const outcome = await awaitBounded(() => dependencies.app.cancel(request), dependencies, deadline);
  return outcome.kind === "value" && "data" in outcome.value ? outcome.value.data : null;
}

async function drainCancellation(
  runId: string,
  dependencies: ResearchCliDependencies,
  deadline: number,
): Promise<{ status: RunStatusResult | null; response: ResearchResponse<RunStatusResult> | null }> {
  const now = dependencies.now ?? Date.now;
  let latest: RunStatusResult | null = null;
  let lastResponse: ResearchResponse<RunStatusResult> | null = null;
  const maximumRounds = Math.ceil(
    (dependencies.cancelCleanupTimeoutMs ?? DEFAULT_CANCEL_CLEANUP_TIMEOUT_MS) /
      Math.min(dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 250),
  ) + 2;
  let rounds = 0;
  while (now() < deadline) {
    if (rounds >= maximumRounds) break;
    rounds += 1;
    const outcome = await awaitBounded(
      () => dependencies.app.status({ runId }),
      dependencies,
      deadline,
    );
    if (outcome.kind === "value") {
      lastResponse = outcome.value;
      if ("data" in outcome.value) {
        latest = outcome.value.data;
        if (TERMINAL_STATUSES.has(latest.status)) return { status: latest, response: lastResponse };
      }
    }
    if (outcome.kind === "timeout" || now() >= deadline) break;
    const sleepOutcome = await boundedSleep(
      dependencies,
      Math.min(dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 250),
      deadline,
    );
    if (sleepOutcome.kind === "timeout" || sleepOutcome.kind === "error") break;
  }
  return { status: latest, response: lastResponse };
}

async function readJsonInput(stdin: AsyncIterable<string | Uint8Array>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const iterator = stdin[Symbol.asyncIterator]();
  let inputAccepted = false;
  try {
    while (true) {
      const next = await awaitWithAbort(iterator.next(), signal);
      if (next.kind === "aborted") throw new CliInterrupted();
      if (next.kind === "error") throw new CliInputError("Input could not be read from stdin.");
      if (next.value.done) break;
      const chunk = next.value.value;
      if (typeof chunk === "string") {
        bytes += new TextEncoder().encode(chunk).byteLength;
        if (bytes > MAX_INPUT_BYTES) throw new CliInputError("Input exceeds the 256 KiB limit.");
        try {
          chunks.push(decoder.decode());
        } catch {
          throw new CliInputError("Input must be valid UTF-8.");
        }
        chunks.push(chunk);
      } else {
        bytes += chunk.byteLength;
        if (bytes > MAX_INPUT_BYTES) throw new CliInputError("Input exceeds the 256 KiB limit.");
        try {
          chunks.push(decoder.decode(chunk, { stream: true }));
        } catch {
          throw new CliInputError("Input must be valid UTF-8.");
        }
      }
    }
    try {
      chunks.push(decoder.decode());
    } catch {
      throw new CliInputError("Input must be valid UTF-8.");
    }
    const source = chunks.join("").trim();
    if (new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(source)) !== source) {
      throw new CliInputError("Input must be valid UTF-8.");
    }
    if (!source) throw new CliInputError("Expected one JSON object on stdin.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new CliInputError("Input is not valid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CliInputError("Input must be one JSON object.");
    }
    inputAccepted = true;
    return parsed as Record<string, unknown>;
  } finally {
    if (!inputAccepted) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {
        // Stdin cleanup is best effort; the owning process still shuts down.
      }
    }
  }
}

function parseArguments(argv: readonly string[], dependencies: ResearchCliDependencies): ParsedArguments {
  const tokens = [...argv];
  if (isResearchCliHelp(tokens)) {
    return { command: "help", format: undefined, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, waitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS };
  }
  const commandToken = tokens.shift();
  const commands: readonly ResearchCliCommand[] = [
    "capabilities", "case-create", "case-get", "case-update", "plan", "start", "status", "result", "cancel",
  ];
  if (!commandToken || !commands.includes(commandToken as ResearchCliCommand)) {
    throw new CliArgumentError("Choose one of the documented research commands or use --help.");
  }

  let format: "json" | "markdown" | undefined;
  let pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let waitTimeoutMs = dependencies.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--format") {
      const value = tokens[++i];
      if (value !== "json" && value !== "markdown") throw new CliArgumentError("--format must be json or markdown.");
      format = value;
      continue;
    }
    if (token === "--poll-interval-ms") {
      pollIntervalMs = parseBoundedInteger(tokens[++i], MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS, "--poll-interval-ms");
      continue;
    }
    if (token === "--wait-timeout-ms") {
      waitTimeoutMs = parseBoundedInteger(tokens[++i], 100, DEFAULT_WAIT_TIMEOUT_MS, "--wait-timeout-ms");
      continue;
    }
    throw new CliArgumentError("Unknown option. Use --help for the supported options.");
  }
  if (format && commandToken !== "result" && commandToken !== "start") {
    throw new CliArgumentError("--format is supported only for result and start.");
  }
  if ((tokens.some((token) => token === "--poll-interval-ms" || token === "--wait-timeout-ms")) && commandToken !== "start") {
    throw new CliArgumentError("Wait options are supported only for start.");
  }
  return { command: commandToken as ResearchCliCommand, format, pollIntervalMs, waitTimeoutMs };
}

function parseBoundedInteger(value: string | undefined, minimum: number, maximum: number, name: string): number {
  if (!value || !/^[0-9]+$/.test(value)) throw new CliArgumentError(`${name} requires an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliArgumentError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

async function sleepFor(dependencies: ResearchCliDependencies, milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (dependencies.sleep) {
    await dependencies.sleep(milliseconds, signal);
    return;
  }
  await new Promise<void>((resolve) => {
    if (!signal) {
      setTimeout(resolve, milliseconds);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

type AwaitOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "error" };

async function awaitBounded<T>(
  invoke: () => Promise<T>,
  dependencies: ResearchCliDependencies,
  deadline: number,
  signal?: AbortSignal,
  dispatchSignal?: AbortSignal,
): Promise<AwaitOutcome<T>> {
  if (signal?.aborted) return { kind: "aborted" };
  const now = dependencies.now ?? Date.now;
  const remaining = deadline - now();
  if (remaining <= 0) return { kind: "timeout" };

  return new Promise<AwaitOutcome<T>>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (outcome: AwaitOutcome<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: "aborted" });
    timer = setTimeout(() => finish({ kind: "timeout" }), remaining);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve().then(() => {
      if (settled) return;
      if (dispatchSignal?.aborted || signal?.aborted) {
        finish({ kind: "aborted" });
        return;
      }
      if (now() >= deadline) {
        finish({ kind: "timeout" });
        return;
      }
      if (dispatchSignal?.aborted || signal?.aborted) {
        finish({ kind: "aborted" });
        return;
      }
      try {
        Promise.resolve(invoke()).then(
          (value) => finish({ kind: "value", value }),
          () => finish({ kind: "error" }),
        );
      } catch {
        finish({ kind: "error" });
      }
    });
  });
}

async function boundedSleep(
  dependencies: ResearchCliDependencies,
  milliseconds: number,
  deadline: number,
  signal?: AbortSignal,
): Promise<AwaitOutcome<void>> {
  const sleeperController = new AbortController();
  try {
    return await awaitBounded(
      () => sleepFor(dependencies, milliseconds, sleeperController.signal),
      dependencies,
      deadline,
      signal,
    );
  } finally {
    sleeperController.abort();
  }
}

type SignalOutcome<T> = { kind: "value"; value: T } | { kind: "aborted" } | { kind: "error" };

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<SignalOutcome<T>> {
  if (signal?.aborted) return { kind: "aborted" };
  return new Promise<SignalOutcome<T>>((resolve) => {
    let settled = false;
    const finish = (outcome: SignalOutcome<T>): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish({ kind: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve(promise).then(
      (value) => finish({ kind: "value", value }),
      () => finish({ kind: "error" }),
    );
  });
}

async function writeJson(write: ResearchCliDependencies["stdout"], value: unknown): Promise<void> {
  await write(`${JSON.stringify(value, null, 2)}\n`);
}

function validationFailure(path: "cli" | "stdin"): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: {
      code: "VALIDATION_ERROR",
      message: "The CLI request is invalid.",
      retryable: false,
      details: { kind: "validation", issues: [{ path, code: "invalid_value" }] },
    },
  };
}

function internalFailure(): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: { code: "INTERNAL_ERROR", message: "The research operation failed.", retryable: false, details: { kind: "internal" } },
  };
}

function timeoutFailure(): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: { code: "INTERNAL_ERROR", message: "The CLI operation exceeded its wait deadline.", retryable: false, details: { kind: "internal" } },
  };
}

function responseFromStatus(status: RunStatusResult): ResearchResponse<RunStatusResult> {
  return { schemaVersion: RESEARCH_SCHEMA_VERSION, data: status };
}

function exitCodeForResearchError(response: ResearchFailure): number {
  switch (response.error.code) {
    case "VALIDATION_ERROR": return EXIT.validation;
    case "NOT_FOUND": return EXIT.notFound;
    case "REVISION_CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
    case "RUN_NOT_CANCELLABLE": return EXIT.conflict;
    case "BUSY": return EXIT.busy;
    case "PROVIDER_UNAVAILABLE": return EXIT.providerUnavailable;
    case "LIMIT_EXCEEDED": return EXIT.limitExceeded;
    case "UNAUTHENTICATED":
    case "FORBIDDEN": return EXIT.forbidden;
    case "RATE_LIMITED": return EXIT.rateLimited;
    case "INTERNAL_ERROR": return EXIT.internal;
  }
}

function defaultIdempotencyKey(): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  return `cli-cancel-${id}`;
}

class CliArgumentError extends Error {}
class CliInputError extends Error {}
class CliInterrupted extends Error {}
