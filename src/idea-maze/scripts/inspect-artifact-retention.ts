import { getOption, hasFlag, writeJson } from './lib/cli.ts';
import { closeDb, getDb } from './lib/db.ts';
import {
  inspectArtifactRetention,
  parseArtifactRetentionDays,
} from './lib/artifact-retention.ts';
import { withStageRunContext } from './lib/run-events.ts';
import { initSchema } from './lib/schema.ts';

function parseRetentionDays(): number {
  return parseArtifactRetentionDays(getOption('--days'));
}

function main(): void {
  let stageRun: ReturnType<typeof withStageRunContext> | null = null;

  try {
    const retentionDays = parseRetentionDays();
    const db = getDb();
    initSchema(db);
    stageRun = withStageRunContext(db, 'inspect-artifact-retention');
    const report = inspectArtifactRetention(db, { retentionDays });
    const { candidates: _candidates, ...summary } = report;
    stageRun.finish(
      'completed',
      'Artifact retention inspection complete.',
      summary,
    );

    if (hasFlag('--json')) {
      writeJson(report);
    } else {
      console.log(
        `Retention check: ${report.eligible_count} records / ${report.eligible_files} files eligible after ${report.retention_days} days ` +
          `(${report.eligible_artifacts} artifacts, ${report.eligible_explorations} explorations).`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stageRun?.finish(
      'error',
      `Artifact retention inspection failed: ${message}`,
    );
    throw error;
  } finally {
    closeDb();
  }
}

main();
