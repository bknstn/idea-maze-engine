import Database from 'better-sqlite3';

import type { ResearchLimits, StartRunInput } from '../contracts.ts';
import { createResearchRunStepExecutor, type ResearchStepAdapter } from '../run-step-executor.ts';
import { createResearchRunManager } from '../run-manager.ts';
import { createResearchRepositories } from '../repositories.ts';
import { initSchema } from '../../scripts/lib/schema.ts';

const [mode, databaseFile, caseId, planId] = process.argv.slice(2);
if (!mode || !databaseFile || !caseId || !planId) throw new TypeError('Synthetic worker arguments are required');

const db = new Database(databaseFile);
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
initSchema(db);
const repositories = createResearchRepositories({ db, workspaceKey: 'synthetic-workspace', clock: () => new Date() });
const serviceSignal = new AbortController().signal;
const limits: ResearchLimits = {
  maxQueries: 4,
  maxFetchedPages: 4,
  maxFollowUpRounds: 1,
  maxWallTimeSeconds: 30,
  maxModelInputTokens: 1000,
  maxModelOutputTokens: 500,
};

function adapter(execute: ResearchStepAdapter['execute']): ResearchStepAdapter {
  return { availability: 'available', providerVersion: 'synthetic-worker-v1', execute };
}

const empty = adapter(async () => ({}));
const runExecutor = createResearchRunStepExecutor({
  adapters: mode === 'owner' ? {
    search: adapter(async ({ run }) => ({
      evidence: [{
        kind: 'search_snippet',
        snippetId: 'snippet_worker_partial',
        queryId: run.snapshot.plan.queries[0].queryId,
        sourceUrl: 'https://example.test/synthetic-worker-source',
        text: 'Synthetic discovery evidence survives worker interruption.',
        assessmentEligible: false,
      }],
    })),
    fetch_originals: adapter(async ({ callProvider }) => {
      process.stdout.write('FETCH_STEP_STARTED\n');
      await callProvider(() => new Promise<never>(() => undefined), 'original_source_fetch');
      return {};
    }),
    map_evidence: empty,
    assess: empty,
  } : {
    search: empty,
    fetch_originals: empty,
    map_evidence: empty,
    assess: empty,
  },
});

const manager = createResearchRunManager({
  repositories,
  executor: runExecutor,
  clock: { now: () => new Date() },
  serviceSignal,
  limits,
  ownerInstanceId: `synthetic-process-${mode}`,
  leaseTtlMilliseconds: mode === 'owner' ? 700 : 2_000,
  renewalIntervalMilliseconds: 100,
  maintenanceIntervalMilliseconds: 50,
});

const request: StartRunInput = {
  idempotencyKey: mode === 'owner' ? 'process-owner-start-01' : 'process-contender-start-01',
  caseId,
  expectedCaseRevision: 1,
  planId,
};
const response = await manager.start(request);
process.stdout.write(`START_RESULT:${JSON.stringify(response)}\n`);

if (mode === 'owner') {
  // Keep the owner process alive while its synthetic adapter is pending.
  setInterval(() => undefined, 1_000);
} else {
  await manager.shutdown();
  db.close();
}
