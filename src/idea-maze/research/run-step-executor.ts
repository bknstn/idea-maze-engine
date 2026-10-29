import { createHash } from 'node:crypto';

import type {
  CoverageGap,
  ProviderAvailability,
  ResearchCapability,
  ResearchAssessment,
  ResearchEvidence,
  ResearchRun,
  ResearchStepName,
  ResearchUsage,
  RunStepStatus,
  WorkspaceRunLease,
} from './contracts.ts';
import type { ResearchClock, TokenBudget } from './ports.ts';
import { ResearchProviderError } from './ports.ts';

export interface ResearchStepCacheSourceVersion {
  sourceItemId: number;
  sourceTextHash: string;
  retrievedAt: string;
}

/**
 * A cache key is intentionally bound to immutable run inputs, every known
 * source version, and the provider implementation version. Callers must not
 * opt into reuse when a provider version is unknown.
 */
export interface ResearchStepCacheKeyInput {
  run: ResearchRun;
  step: ResearchStepName;
  sourceVersions: readonly ResearchStepCacheSourceVersion[];
  providerVersion: string;
}

export function researchStepCacheKey(input: ResearchStepCacheKeyInput): string {
  if (typeof input.providerVersion !== 'string' || input.providerVersion.trim() === '') {
    throw new TypeError('A provider version is required for a reusable research step');
  }
  const sourceVersions = [...input.sourceVersions]
    .map((source) => ({
      sourceItemId: source.sourceItemId,
      sourceTextHash: source.sourceTextHash,
      retrievedAt: source.retrievedAt,
    }))
    .sort((left, right) => left.sourceItemId - right.sourceItemId ||
      left.sourceTextHash.localeCompare(right.sourceTextHash) || left.retrievedAt.localeCompare(right.retrievedAt));
  const value = JSON.stringify({
    version: 1,
    step: input.step,
    caseRevision: input.run.snapshot.caseRevision,
    plan: input.run.snapshot.plan,
    sourceVersions,
    providerVersion: input.providerVersion,
  });
  return `research-step-v1:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export interface ResearchStepCacheEntry {
  cacheKey: string;
  status: RunStepStatus;
  verified: boolean;
  sourceVersions: readonly ResearchStepCacheSourceVersion[];
  output: ResearchStepOutput;
}

/** Reuse requires a successful, verified cache entry with the exact version key. */
export function isReusableResearchStepCacheEntry(
  entry: ResearchStepCacheEntry,
  expectedCacheKey: string,
): boolean {
  return entry.status === 'succeeded' && entry.verified === true && entry.cacheKey === expectedCacheKey;
}

export interface ResearchStepOutput {
  evidence?: ResearchEvidence[];
  assessment?: ResearchAssessment;
  coverageGaps?: CoverageGap[];
  usage?: Partial<Omit<ResearchUsage, 'elapsedMilliseconds'>>;
}

export type ResearchRunControlReason =
  | 'cancelled'
  | 'service_shutdown'
  | 'lease_lost'
  | 'deadline_reached'
  | 'limit_reached'
  | 'step_failed';

/** Internal control flow, never returned as an error envelope or logged. */
export class ResearchRunControlError extends Error {
  constructor(readonly reason: ResearchRunControlReason) {
    super('Research run control stopped the current step');
    this.name = 'ResearchRunControlError';
  }
}

export interface ResearchStepCallGuard {
  /** Recheck lease, cancellation, shutdown, and deadline before each dispatch. */
  assertCanDispatch(): void;
  /** Races adapter work against the run signal and never waits on an ignored abort. */
  callProvider<T>(
    call: (signal: AbortSignal, tokenBudget: TokenBudget | null) => Promise<T>,
    capability?: ResearchCapability,
  ): Promise<T>;
  /** Lease-validated synchronous persistence for fetched originals and mapped evidence. */
  withWrite<T>(effect: (lease: WorkspaceRunLease) => T): T;
}

export interface ResearchStepAdapterContext extends ResearchStepCallGuard {
  run: ResearchRun;
  step: ResearchStepName;
  signal: AbortSignal;
  deadlineAt: string;
  maxModelInputTokens: number;
  maxModelOutputTokens: number;
  maxSearchRequests: number;
  maxFetchedPages: number;
  maxFollowUpRounds: number;
  clock: ResearchClock;
  providerVersion: string | null;
  /** Returns null when provider-version data is unavailable, disabling cache reuse. */
  cacheKeyFor(sourceVersions: readonly ResearchStepCacheSourceVersion[]): string | null;
}

export interface ResearchStepAdapter {
  availability: ProviderAvailability;
  /** Version string for the implementation, not credentials or a model secret. */
  providerVersion: string | null;
  execute(context: ResearchStepAdapterContext): Promise<ResearchStepOutput>;
}

export interface ResearchStepExecutionResult {
  status: Extract<RunStepStatus, 'succeeded' | 'failed' | 'skipped_unavailable'>;
  providerAvailability: ProviderAvailability | null;
  failureCode: ResearchRun['steps'][number]['failureCode'];
  output: ResearchStepOutput;
}

export interface ResearchRunStepExecutor {
  executeStep(input: ResearchStepAdapterContext): Promise<ResearchStepExecutionResult>;
}

export interface ResearchRunStepExecutorOptions {
  adapters: Partial<Record<ResearchStepName, ResearchStepAdapter>>;
}

/**
 * Provider-neutral step dispatcher. It does not retry failed work; a caller
 * must explicitly start another run to perform new external work.
 */
export function createResearchRunStepExecutor(options: ResearchRunStepExecutorOptions): ResearchRunStepExecutor {
  return Object.freeze({
    async executeStep(input: ResearchStepAdapterContext): Promise<ResearchStepExecutionResult> {
      const adapter = options.adapters[input.step];
      if (!adapter || adapter.availability !== 'available') {
        const availability = adapter?.availability ?? 'not_configured';
        return {
          status: 'skipped_unavailable',
          providerAvailability: availability,
          failureCode: 'PROVIDER_UNAVAILABLE',
          output: {
            coverageGaps: [{
              reason: 'provider_unavailable',
              detail: `The ${input.step} step provider is ${availability.replaceAll('_', ' ')}.`,
              queryId: null,
              hypothesisId: null,
            }],
          },
        };
      }

      input.assertCanDispatch();
      try {
        const adapterContext: ResearchStepAdapterContext = {
          ...input,
          providerVersion: adapter.providerVersion,
          cacheKeyFor(sourceVersions) {
            if (!adapter.providerVersion) return null;
            return researchStepCacheKey({ run: input.run, step: input.step, sourceVersions, providerVersion: adapter.providerVersion });
          },
        };
        const output = await input.callProvider((signal) => adapter.execute({ ...adapterContext, signal }));
        return { status: 'succeeded', providerAvailability: 'available', failureCode: null, output };
      } catch (error) {
        if (error instanceof ResearchRunControlError) throw error;
        if (input.signal.aborted) throw error;
        if (error instanceof ResearchProviderError && error.kind === 'unavailable') {
          return {
            status: 'skipped_unavailable',
            providerAvailability: 'unavailable',
            failureCode: 'PROVIDER_UNAVAILABLE',
            output: {
              coverageGaps: [{
                reason: 'provider_unavailable',
                detail: 'A configured research provider became unavailable during the step.',
                queryId: null,
                hypothesisId: null,
              }],
            },
          };
        }
        return {
          status: 'failed',
          providerAvailability: 'available',
          failureCode: error instanceof ResearchProviderError && error.kind === 'rate_limited'
            ? 'RATE_LIMITED'
            : 'INTERNAL_ERROR',
          output: {
            coverageGaps: [{
              reason: input.step === 'search' ? 'search_failed' : 'fetch_failed',
              detail: 'The research step failed before it produced a complete result.',
              queryId: null,
              hypothesisId: null,
            }],
          },
        };
      }
    },
  });
}
