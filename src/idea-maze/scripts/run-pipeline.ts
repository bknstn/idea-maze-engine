/**
 * Run the full harvest pipeline with run-lock protection.
 *
 * Stages: ingest-reddit → extract-insights → refresh-opportunities → process-opportunities
 *
 * Used by scheduled tasks to run the pipeline safely without overlap.
 * Skips stages that fail and reports results.
 *
 * Usage: tsx run-pipeline.ts
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { getDb, closeDb } from './lib/db.ts';
import { hasFlag, writeJson } from './lib/cli.ts';
import {
  PARENT_RUN_ID_ENV,
  createRun,
  recordRunEvent,
  updateRunStatus,
} from './lib/run-events.ts';
import { initSchema } from './lib/schema.ts';
import { acquireRunLock, releaseRunLock, getCounts } from './lib/queries.ts';

const SCRIPTS_DIR = resolve(import.meta.dirname ?? '.');

interface StageResult {
  stage: string;
  ok: boolean;
  output: string;
  durationMs: number;
}

const DEFAULT_STAGE_TIMEOUT_MS = 5 * 60 * 1000;
const PROCESS_OPPORTUNITIES_TIMEOUT_MS = 15 * 60 * 1000;

function runStage(
  name: string,
  script: string,
  parentRunId: number,
  timeoutMs = DEFAULT_STAGE_TIMEOUT_MS,
): StageResult {
  const start = Date.now();
  try {
    const output = execFileSync('tsx', [script], {
      cwd: SCRIPTS_DIR,
      encoding: 'utf-8',
      env: {
        ...process.env,
        [PARENT_RUN_ID_ENV]: String(parentRunId),
      },
      timeout: timeoutMs,
    });
    return {
      stage: name,
      ok: true,
      output: output.trim(),
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    const output = err.stdout?.toString() ?? err.stderr?.toString() ?? err.message;
    return {
      stage: name,
      ok: false,
      output: output.trim(),
      durationMs: Date.now() - start,
    };
  }
}

function main() {
  const jsonMode = hasFlag('--json');
  const db = getDb();
  initSchema(db);
  const pipelineRunId = createRun(db, {
    metadata: {
      trigger: 'pipeline',
    },
    requestedBy: 'system',
    runType: 'pipeline',
    targetId: 'pipeline',
    targetType: 'pipeline',
  });

  if (!acquireRunLock('pipeline')) {
    if (!jsonMode)
      console.log('Pipeline already running (lock held). Skipping.');
    updateRunStatus(db, pipelineRunId, 'completed', {
      metadata: {
        skipped: true,
      },
    });
    if (jsonMode) {
      writeJson({
        runId: pipelineRunId,
        skipped: true,
        reason: 'lock_held',
      });
    }
    closeDb();
    return;
  }

  if (!jsonMode) console.log('Pipeline started.');
  const results: StageResult[] = [];

  try {
    // Ingestion
    results.push(runStage('ingest-reddit', 'ingest-reddit.ts', pipelineRunId));

    // Analysis
    results.push(
      runStage('extract-insights', 'extract-insights.ts', pipelineRunId),
    );
    results.push(
      runStage(
        'refresh-opportunities',
        'refresh-opportunities.ts',
        pipelineRunId,
      ),
    );
    results.push(
      runStage(
        'process-opportunities',
        'process-opportunities.ts',
        pipelineRunId,
        PROCESS_OPPORTUNITIES_TIMEOUT_MS,
      ),
    );
  } finally {
    releaseRunLock('pipeline');
  }

  // Report
  const counts = getCounts();
  if (!jsonMode) console.log('\n--- Pipeline Results ---');
  for (const r of results) {
    const status = r.ok ? 'OK' : 'FAILED';
    const lastLine = r.output.split('\n').pop() ?? '';
    if (!jsonMode) {
      console.log(`  ${r.stage}: ${status} (${r.durationMs}ms) — ${lastLine}`);
    }
    recordRunEvent(db, {
      eventType: r.ok ? 'pipeline.stage_completed' : 'pipeline.stage_failed',
      payload: {
        duration_ms: r.durationMs,
        output_tail: lastLine,
      },
      runId: pipelineRunId,
      stage: r.stage,
      status: r.ok ? 'ok' : 'error',
      summary: `${r.stage} ${r.ok ? 'completed' : 'failed'} in ${r.durationMs}ms.`,
    });
  }
  if (!jsonMode) {
    console.log(
      `\nTotals: ${counts.source_items} sources, ${counts.insights} insights, ${counts.opportunities} opportunities, ${counts.runs_pending} open research runs, ${counts.artifacts} artifacts`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    if (!jsonMode) {
      console.error(
        `\n${failed.length} stage(s) failed: ${failed.map((r) => r.stage).join(', ')}`,
      );
    }
    updateRunStatus(db, pipelineRunId, 'error', {
      error: failed
        .map((r) => `${r.stage}: ${(r.output.split('\n').pop() ?? '').trim()}`)
        .join('; '),
      metadata: {
        counts,
        failed_stages: failed.map((r) => r.stage),
      },
    });
  } else {
    updateRunStatus(db, pipelineRunId, 'completed', {
      metadata: {
        counts,
      },
    });
  }

  if (jsonMode) {
    writeJson({
      runId: pipelineRunId,
      skipped: false,
      ok: failed.length === 0,
      counts,
      stages: results.map((result) => ({
        durationMs: result.durationMs,
        ok: result.ok,
        outputTail: result.output.split('\n').pop() ?? '',
        stage: result.stage,
      })),
      failedStages: failed.map((result) => result.stage),
    });
  }

  closeDb();
}

main();
