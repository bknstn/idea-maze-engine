/**
 * Explicit, per-workspace application dependencies. Importing this module only
 * defines helpers; it does not open a database, initialize a schema, run a CLI,
 * or contact a provider.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { ResearchLimits } from "./contracts.js";
import { RESEARCH_LIMIT_CEILINGS } from "./validation.js";
import type {
  ProviderBinding,
  ResearchClock,
  ResearchIdFactory,
  ResearchIdKind,
  ResearchProviderBindings,
  SafeLogEntry,
  StructuredSafeLogger,
} from "./ports.js";

export interface ResearchPathOptions {
  /** Existing directory selected by the host application. */
  workspaceRoot: string;
  /** Workspace-relative locations only. */
  dataDirectory?: string;
  databaseFile?: string | null;
  artifactsDirectory?: string;
}

export interface ResearchWorkspacePaths {
  readonly workspaceRoot: string;
  readonly dataDirectory: string;
  readonly databaseFile: string | null;
  readonly artifactsDirectory: string;
}

export type ResearchDatabaseOptions =
  | { ownership: "borrowed"; connection: Database.Database }
  | { ownership: "owned"; connection?: never };

export interface ResearchContextOptions {
  database: ResearchDatabaseOptions;
  paths: ResearchPathOptions;
  /** Stable application identity for this workspace; never returned by tools or logged. */
  workspaceKey: string;
  clock: ResearchClock;
  logger: StructuredSafeLogger;
  providers: ResearchProviderBindings;
  /** Service-owned lifetime signal, independent of any client/request signal. */
  serviceLifetimeSignal: AbortSignal;
  limits: ResearchLimits;
  idFactory: ResearchIdFactory;
}

export interface AbortScope {
  signal: AbortSignal;
  dispose(): void;
}

export interface ResearchContext {
  readonly db: Database.Database;
  readonly databaseOwnership: "borrowed" | "owned";
  readonly paths: ResearchWorkspacePaths;
  readonly workspaceKey: string;
  readonly clock: ResearchClock;
  readonly logger: StructuredSafeLogger;
  readonly providers: ResearchProviderBindings;
  readonly limits: Readonly<ResearchLimits>;
  readonly idFactory: ResearchIdFactory;
  /** Combined service-owner and context-shutdown signal; never an HTTP signal. */
  readonly serviceSignal: AbortSignal;
  readonly isDisposed: boolean;
  /** Link explicit run cancellation to service shutdown for external adapter calls. */
  createProviderSignal(runCancellationSignal?: AbortSignal): AbortScope;
  /** Stop service-owned work while retaining an owned database until disposal. */
  shutdown(): void;
  /** Idempotent. Closes only a database opened and owned by this context. */
  dispose(): void;
}

const DEFAULT_PATHS = Object.freeze({
  dataDirectory: "data",
  databaseFile: "data/lab.db",
  artifactsDirectory: "artifacts",
});

const DEFAULT_ID_PREFIX = "research";

export function randomResearchIdFactory(kind: ResearchIdKind): string {
  return `${DEFAULT_ID_PREFIX}_${kind}_${randomUUID()}`;
}

/**
 * Resolve workspace-relative paths and reject lexical traversal and detected
 * symlink escapes. The root must already exist and be a directory. Filesystem
 * checks narrow path redirection risks but cannot eliminate concurrent TOCTOU
 * changes by another process.
 */
export function resolveResearchPaths(options: ResearchPathOptions): ResearchWorkspacePaths {
  if (!isAbsolute(options.workspaceRoot)) {
    throw new TypeError("workspaceRoot must be an absolute path");
  }
  const root = realpathSync(options.workspaceRoot);
  if (!statSync(root).isDirectory()) throw new TypeError("workspaceRoot must be a directory");

  const dataDirectory = resolveUnderRoot(root, options.dataDirectory ?? DEFAULT_PATHS.dataDirectory);
  const databaseValue = options.databaseFile === undefined ? DEFAULT_PATHS.databaseFile : options.databaseFile;
  const databaseFile = databaseValue === null ? null : resolveUnderRoot(root, databaseValue);
  const artifactsDirectory = resolveUnderRoot(root, options.artifactsDirectory ?? DEFAULT_PATHS.artifactsDirectory);

  return Object.freeze({ workspaceRoot: root, dataDirectory, databaseFile, artifactsDirectory });
}

/** Resolve a controlled, relative application path within an already bound workspace. */
export function resolveWorkspacePath(paths: ResearchWorkspacePaths, relativePath: string): string {
  return resolveUnderRoot(paths.workspaceRoot, relativePath);
}

function resolveUnderRoot(root: string, relativePath: string): string {
  if (typeof relativePath !== "string" || relativePath.trim() === "" || isAbsolute(relativePath)) {
    throw new TypeError("workspace paths must be non-empty relative paths");
  }
  const candidate = resolve(root, relativePath);
  if (!isInside(root, candidate) || candidate === root) {
    throw new TypeError("workspace path escapes its configured root");
  }

  let existing = candidate;
  while (true) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  // realpathSync also fails closed for dangling symlinks.
  const realExisting = realpathSync(existing);
  if (!isInside(root, realExisting)) {
    throw new TypeError("workspace path resolves outside its configured root");
  }
  try {
    lstatSync(candidate);
    const realCandidate = realpathSync(candidate);
    if (!isInside(root, realCandidate)) {
      throw new TypeError("workspace path resolves outside its configured root");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return candidate;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function validateResearchLimits(limits: ResearchLimits): Readonly<ResearchLimits> {
  const keys = Object.keys(RESEARCH_LIMIT_CEILINGS) as Array<keyof ResearchLimits>;
  const values = {} as ResearchLimits;
  for (const key of keys) {
    const value = limits[key];
    const min = key === "maxFollowUpRounds" ? 0 : 1;
    const max = RESEARCH_LIMIT_CEILINGS[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new RangeError(`${key} must be an integer between ${min} and ${max}`);
    }
    values[key] = value;
  }
  return Object.freeze(values);
}

export function providerCapabilityStatus(binding: ProviderBinding<unknown>): {
  availability: ProviderBinding<unknown>["availability"];
  adapter: string | null;
} {
  return {
    availability: binding.availability,
    adapter: binding.availability === "available" ? binding.adapter : null,
  };
}

function validateProviderBinding<T>(value: unknown, providerMethod: keyof T): ProviderBinding<T> {
  if (!value || typeof value !== "object") throw new TypeError("provider bindings must be explicit objects");
  const binding = value as Partial<ProviderBinding<T>>;
  if (!["available", "not_configured", "unavailable"].includes(binding.availability ?? "")) {
    throw new TypeError("provider availability is invalid");
  }
  if (binding.availability === "available") {
    if (!isSafeAdapterName(binding.adapter ?? null) || !binding.provider ||
        typeof (binding.provider as Record<keyof T, unknown>)[providerMethod] !== "function") {
      throw new TypeError("available providers require a safe adapter label and implementation");
    }
  } else if (binding.provider !== null || binding.adapter !== null) {
    throw new TypeError("unavailable providers cannot expose an adapter or implementation");
  }
  return Object.freeze({
    availability: binding.availability as ProviderBinding<T>["availability"],
    adapter: binding.adapter ?? null,
    provider: binding.provider ?? null,
  });
}

function validateProviderBindings(providers: ResearchProviderBindings): ResearchProviderBindings {
  if (!providers || typeof providers !== "object") throw new TypeError("provider bindings are required");
  return Object.freeze({
    model: validateProviderBinding(providers.model, "generateJson"),
    search: validateProviderBinding(providers.search, "search"),
    originalSourceReader: validateProviderBinding(providers.originalSourceReader, "fetchOriginal"),
  });
}

function isSafeAdapterName(adapter: string | null): adapter is string {
  return typeof adapter === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(adapter);
}

function validateWorkspaceKey(workspaceKey: string): string {
  if (typeof workspaceKey !== "string" || workspaceKey.trim() === "" || workspaceKey.length > 128) {
    throw new TypeError("workspaceKey must be a non-empty stable identifier of at most 128 characters");
  }
  return workspaceKey;
}

function linkAbortSignals(signals: readonly AbortSignal[]): AbortScope {
  const controller = new AbortController();
  const removers: Array<() => void> = [];
  let disposed = false;

  const abortFrom = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("Research operation cancelled", "AbortError"));
    }
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abortFrom();
      break;
    }
    const listener = () => abortFrom();
    signal.addEventListener("abort", listener, { once: true });
    removers.push(() => signal.removeEventListener("abort", listener));
  }

  return {
    signal: controller.signal,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const remove of removers) remove();
    },
  };
}

function validateLogger(logger: StructuredSafeLogger): StructuredSafeLogger {
  if (!logger || typeof logger.log !== "function") throw new TypeError("logger.log is required");
  const log = logger.log.bind(logger);
  return Object.freeze({ log });
}

function validateClock(clock: ResearchClock): ResearchClock {
  if (!clock || typeof clock.now !== "function") throw new TypeError("clock.now is required");
  const now = clock.now.bind(clock);
  return Object.freeze({ now });
}

function validateIdFactory(idFactory: ResearchIdFactory): ResearchIdFactory {
  if (typeof idFactory !== "function") throw new TypeError("idFactory is required");
  return idFactory;
}

/**
 * Create a workspace-bound context. Schema initialization is intentionally a
 * separate, explicit caller action so this factory does not race repository
 * migrations or mutate the legacy application schema.
 */
export function createResearchContext(options: ResearchContextOptions): ResearchContext {
  const workspaceKey = validateWorkspaceKey(options.workspaceKey);
  const limits = validateResearchLimits(options.limits);
  const paths = resolveResearchPaths(options.paths);
  const logger = validateLogger(options.logger);
  const clock = validateClock(options.clock);
  const idFactory = validateIdFactory(options.idFactory);
  const providers = validateProviderBindings(options.providers);
  if (!options.serviceLifetimeSignal || typeof options.serviceLifetimeSignal.addEventListener !== "function") {
    throw new TypeError("serviceLifetimeSignal is required");
  }
  if (options.database.ownership === "owned" && !paths.databaseFile) {
    throw new TypeError("owned databases require a workspace-relative databaseFile");
  }

  let db: Database.Database;
  const ownership: "borrowed" | "owned" = options.database.ownership;
  if (options.database.ownership === "borrowed") {
    db = options.database.connection;
    if (!db || db.open !== true) throw new TypeError("borrowed database connection must be open");
  } else {
    const databasePath = paths.databaseFile as string;
    mkdirSync(dirname(databasePath), { recursive: true });
    // Recheck after creating directories to catch path changes observed before open.
    const verifiedDatabasePath = resolveUnderRoot(paths.workspaceRoot, options.paths.databaseFile ?? DEFAULT_PATHS.databaseFile);
    db = new Database(verifiedDatabasePath);
    try {
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
    } catch (error) {
      db.close();
      throw error;
    }
  }

  const serviceController = new AbortController();
  const serviceScope = linkAbortSignals([options.serviceLifetimeSignal, serviceController.signal]);
  let isDisposed = false;
  let ownedDatabaseClosed = false;

  const context: ResearchContext = {
    db,
    databaseOwnership: ownership,
    paths,
    workspaceKey,
    clock,
    logger,
    providers,
    limits,
    idFactory,
    serviceSignal: serviceScope.signal,
    get isDisposed() {
      return isDisposed;
    },
    createProviderSignal(runCancellationSignal) {
      if (isDisposed) throw new Error("research context has been disposed");
      const scope = runCancellationSignal
        ? linkAbortSignals([serviceScope.signal, runCancellationSignal])
        : linkAbortSignals([serviceScope.signal]);
      return scope;
    },
    shutdown() {
      if (serviceController.signal.aborted) return;
      serviceController.abort(new DOMException("Research service shutdown", "AbortError"));
      const entry: SafeLogEntry = { event: "service.shutdown" };
      logger.log(entry);
    },
    dispose() {
      if (isDisposed) return;
      isDisposed = true;
      try {
        context.shutdown();
      } finally {
        try {
          serviceScope.dispose();
        } finally {
          if (ownership === "owned" && !ownedDatabaseClosed) {
            ownedDatabaseClosed = true;
            if (db.open) db.close();
          }
        }
      }
    },
  };

  return Object.freeze(context);
}
