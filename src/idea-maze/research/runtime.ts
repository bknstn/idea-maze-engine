import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { initSchema } from "../scripts/lib/schema.js";
import { createSafeOriginalSourceReaderBinding, pinnedNodeHttpTransport, systemSourceDnsResolver } from "./source-reader.js";
import { createTavilySearchBinding } from "./search-adapter.js";
import { createRegisteredModelBinding } from "./model-adapter.js";
import { createResearchContext, randomResearchIdFactory } from "./context.js";
import type { ResearchContext, ResearchContextOptions } from "./context.js";
import {
  RESEARCH_SCHEMA_VERSION,
  success,
  type ResearchApplication,
  type ResearchCapabilities,
  type ResearchFailure,
  type ResearchLimits,
  type ResearchResponse,
  type ResearchResultPage,
} from "./contracts.js";
import { createResearchCaseService } from "./case-service.js";
import { createResearchPlanner } from "./planner.js";
import { createResearchOrchestrator } from "./orchestrator.js";
import { createResearchRepositories, RepositoryNotFoundError, type ResearchRepositories } from "./repositories.js";
import { createResearchResultService, InvalidResearchResultCursorError, ResearchResultTooLargeError } from "./report-renderer.js";
import { createResearchRunManager } from "./run-manager.js";
import { createResearchRunStepExecutor } from "./run-step-executor.js";
import type {
  ResearchClock,
  ResearchIdFactory,
  ResearchProviderBindings,
  SafeLogEntry,
  StructuredSafeLogger,
} from "./ports.js";
import { providerCapabilityStatus } from "./context.js";
import { ContractValidationError, validateToolInput, validationFailure, RESEARCH_LIMIT_CEILINGS } from "./validation.js";
import type { ResultInput } from "./contracts.js";

export interface ResearchApplicationOptions {
  repositories?: ResearchRepositories;
}

export type ComposedResearchApplication = ResearchApplication & { shutdown(): Promise<void> };

export interface ResearchRuntimeOptions {
  /** Existing workspace root. Otherwise the factory reads IDEA_MAZE_HOME, then cwd. */
  workspaceRoot?: string;
  /** Optional stable host identity; it is persisted internally and never returned by tools. */
  workspaceKey?: string;
  /** Explicit environment snapshot used by provider composition and data-root selection. */
  environment?: NodeJS.ProcessEnv;
  /** Full provider override for hosts and tests. Omission composes built-in adapters. */
  providers?: ResearchProviderBindings;
  limits?: ResearchLimits;
  serviceLifetimeSignal?: AbortSignal;
  clock?: ResearchClock;
  logger?: StructuredSafeLogger;
  idFactory?: ResearchIdFactory;
  /** Injected to make the default search binding's network capability explicit. */
  fetch?: typeof fetch;
  databaseFile?: string | null;
}

export interface ResearchRuntime {
  context: ResearchContext;
  application: ComposedResearchApplication;
  shutdown(): Promise<void>;
}

/**
 * Compose the nine shared application methods from the frozen service ports.
 * The caller owns the supplied context and database lifecycle; shutdown stops
 * run work but does not dispose a borrowed or owned context.
 */
export function createResearchApplication(
  context: ResearchContext,
  options: ResearchApplicationOptions = {},
): ComposedResearchApplication {
  const repositories = options.repositories ?? createResearchRepositories({
    db: context.db,
    workspaceKey: context.workspaceKey,
    clock: () => context.clock.now(),
    idFactory: context.idFactory,
  });
  if (repositories.workspaceKey !== context.workspaceKey) {
    throw new TypeError("Application repositories must match the bound workspace");
  }

  const cases = createResearchCaseService(context, repositories);
  const planner = createResearchPlanner(context, repositories);
  const orchestrator = createResearchOrchestrator({ context, repositories });
  const executor = createResearchRunStepExecutor({ adapters: orchestrator });
  const runs = createResearchRunManager({
    repositories,
    executor,
    clock: context.clock,
    serviceSignal: context.serviceSignal,
    limits: context.limits,
  });
  const resultService = createResearchResultService(repositories);
  let shutdownPromise: Promise<void> | null = null;

  const application: ComposedResearchApplication = Object.freeze({
    async capabilities(): Promise<ResearchResponse<ResearchCapabilities>> {
      return success({
        capabilities: {
          model: providerCapabilityStatus(context.providers.model),
          search: providerCapabilityStatus(context.providers.search),
          original_source_fetch: providerCapabilityStatus(context.providers.originalSourceReader),
        },
        limits: { ...context.limits },
        storageMode: "single_owner_workspace",
      });
    },
    createCase: cases.createCase,
    getCase: cases.getCase,
    updateCase: cases.updateCase,
    plan: planner.plan,
    start: runs.start,
    status: runs.status,
    async result(input: ResultInput): Promise<ResearchResponse<ResearchResultPage>> {
      if (context.isDisposed || context.serviceSignal.aborted) return serviceInactiveFailure();
      let request: ResultInput;
      try {
        request = validateToolInput("research_result", input);
      } catch (error) {
        return error instanceof ContractValidationError ? validationFailure(error) : internalFailure();
      }
      try {
        return success(resultService.result(request));
      } catch (error) {
        if (error instanceof RepositoryNotFoundError && error.resource === "run") {
          return notFoundFailure("run", error.id);
        }
        if (error instanceof InvalidResearchResultCursorError) {
          return validationFailure(new ContractValidationError("cursor", "invalid_value"));
        }
        if (error instanceof ResearchResultTooLargeError) return internalFailure();
        return internalFailure();
      }
    },
    cancel: runs.cancel,
    async shutdown(): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        try {
          context.shutdown();
        } catch {
          // A diagnostic logger failure must not skip the run drain.
        }
        try {
          await runs.shutdown();
        } finally {
          orchestrator.shutdown();
        }
      })();
      return shutdownPromise;
    },
  });

  return application;
}

/**
 * Synchronously initialize one owned workspace and bind the shared app. The
 * returned shutdown waits for run-manager cleanup before closing SQLite.
 */
export function createResearchRuntime(options: ResearchRuntimeOptions = {}): ResearchRuntime {
  const environment = Object.freeze({ ...(options.environment ?? process.env) }) as NodeJS.ProcessEnv;
  const workspaceRoot = options.workspaceRoot ?? environment.IDEA_MAZE_HOME ?? process.cwd();
  const clock = options.clock ?? { now: () => new Date() };
  const defaultLogger: StructuredSafeLogger = { log: (_entry: Readonly<SafeLogEntry>) => undefined };
  const logger = options.logger ?? defaultLogger;
  const limits = options.limits ?? RESEARCH_LIMIT_CEILINGS;
  const serviceLifetimeSignal = options.serviceLifetimeSignal ?? new AbortController().signal;
  const environmentProviders = options.providers ?? createEnvironmentProviders(environment, clock, options.fetch ?? globalThis.fetch);
  const contextOptions: ResearchContextOptions = {
    database: { ownership: "owned" },
    paths: {
      workspaceRoot,
      ...(options.databaseFile === undefined ? {} : { databaseFile: options.databaseFile }),
    },
    workspaceKey: options.workspaceKey ?? workspaceKeyFor(workspaceRoot),
    clock,
    logger,
    providers: environmentProviders,
    serviceLifetimeSignal,
    limits,
    idFactory: options.idFactory ?? randomResearchIdFactory,
  };

  const context = createResearchContext(contextOptions);
  try {
    initSchema(context.db);
    const application = createResearchApplication(context);
    let shutdownPromise: Promise<void> | null = null;
    return Object.freeze({
      context,
      application,
      shutdown(): Promise<void> {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
          try {
            await application.shutdown();
          } finally {
            context.dispose();
          }
        })();
        return shutdownPromise;
      },
    });
  } catch (error) {
    context.dispose();
    throw error;
  }
}

function createEnvironmentProviders(
  environment: NodeJS.ProcessEnv,
  clock: ResearchClock,
  fetcher: typeof fetch,
): ResearchProviderBindings {
  return {
    model: createRegisteredModelBinding({ environment }),
    search: createTavilySearchBinding({ apiKey: environment.TAVILY_API_KEY, fetch: fetcher }),
    originalSourceReader: createSafeOriginalSourceReaderBinding({
      dns: systemSourceDnsResolver,
      transport: pinnedNodeHttpTransport,
      clock: { now: () => clock.now() },
    }),
  };
}

function workspaceKeyFor(workspaceRoot: string): string {
  const canonicalPath = realpathSync(resolve(workspaceRoot));
  return `workspace_${createHash("sha256").update(canonicalPath, "utf8").digest("hex")}`;
}

function serviceInactiveFailure(): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: { code: "INTERNAL_ERROR", message: "The research service is not active.", retryable: false, details: { kind: "internal" } },
  };
}

function internalFailure(): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: { code: "INTERNAL_ERROR", message: "The research request could not be completed.", retryable: false, details: { kind: "internal" } },
  };
}

function notFoundFailure(resource: "case" | "plan" | "hypothesis" | "run", id: string): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: {
      code: "NOT_FOUND",
      message: `The ${resource} was not found in this workspace.`,
      retryable: false,
      details: { kind: "not_found", resource, id },
    },
  };
}
