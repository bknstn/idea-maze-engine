import { describe, expect, it } from 'vitest';

import type { ResearchRun } from './contracts.ts';
import {
  isReusableResearchStepCacheEntry,
  researchStepCacheKey,
} from './run-step-executor.ts';

const run: ResearchRun = {
  runId: 'run_synthetic_1',
  caseId: 'case_synthetic_1',
  caseRevision: 1,
  planId: 'plan_synthetic_1',
  status: 'queued',
  snapshot: {
    caseRevision: {
      caseId: 'case_synthetic_1',
      revision: 1,
      intake: { ideaSummary: 'A synthetic workflow helper' },
      hypothesisRevisions: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    plan: {
      planId: 'plan_synthetic_1',
      caseId: 'case_synthetic_1',
      caseRevision: 1,
      queries: [],
      limits: {
        maxQueries: 2,
        maxFetchedPages: 2,
        maxFollowUpRounds: 0,
        maxWallTimeSeconds: 60,
        maxModelInputTokens: 1000,
        maxModelOutputTokens: 500,
      },
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  },
  steps: [],
  usage: {
    searchRequests: 0,
    fetchedPages: 0,
    modelInputTokens: null,
    modelOutputTokens: null,
    providerCostMicros: null,
    elapsedMilliseconds: 0,
  },
  assessment: null,
  coverageGaps: [],
  stoppingReason: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  cancelRequestedAt: null,
};

describe('run step cache identity', () => {
  const base = {
    run,
    step: 'map_evidence' as const,
    sourceVersions: [
      { sourceItemId: 7, sourceTextHash: 'synthetic-hash-v1', retrievedAt: '2026-01-01T00:00:00.000Z' },
      { sourceItemId: 8, sourceTextHash: 'synthetic-hash-v2', retrievedAt: '2026-01-02T00:00:00.000Z' },
    ],
    providerVersion: 'synthetic-adapter-v1',
  };

  it('binds a reusable step to the case, plan, source versions, and provider version', () => {
    const key = researchStepCacheKey(base);
    expect(researchStepCacheKey({ ...base, providerVersion: 'synthetic-adapter-v2' })).not.toBe(key);
    expect(researchStepCacheKey({ ...base, sourceVersions: [{ ...base.sourceVersions[0], sourceTextHash: 'synthetic-hash-v2' }] })).not.toBe(key);
    expect(researchStepCacheKey({ ...base, step: 'assess' })).not.toBe(key);
    expect(researchStepCacheKey({ ...base, sourceVersions: [...base.sourceVersions].reverse() })).toBe(key);
    expect(() => researchStepCacheKey({ ...base, providerVersion: '' })).toThrow(/provider version/);
  });

  it('accepts only a completed verified entry with the exact cache key', () => {
    const cacheKey = researchStepCacheKey(base);
    const entry = {
      cacheKey,
      status: 'succeeded' as const,
      verified: true,
      sourceVersions: base.sourceVersions,
      output: {},
    };
    expect(isReusableResearchStepCacheEntry(entry, cacheKey)).toBe(true);
    expect(isReusableResearchStepCacheEntry({ ...entry, status: 'running' }, cacheKey)).toBe(false);
    expect(isReusableResearchStepCacheEntry({ ...entry, verified: false }, cacheKey)).toBe(false);
    expect(isReusableResearchStepCacheEntry(entry, `${cacheKey}-different`)).toBe(false);
  });
});
