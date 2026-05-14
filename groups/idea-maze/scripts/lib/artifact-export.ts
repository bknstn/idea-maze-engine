import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import type Database from 'better-sqlite3';

import { recordRunEvent } from './run-events.ts';

const GROUP_DIR = process.env.WORKSPACE_GROUP ?? '/workspace/group';
const IPC_DIR = process.env.WORKSPACE_IPC ?? '/workspace/ipc';
const ARTIFACT_SOURCE_PREFIX = 'data/artifacts';

export type GitHubExportQueueStatus = 'disabled' | 'queued';

export interface GitHubExportState {
  status: GitHubExportQueueStatus;
}

export function artifactSourceRelativePath(
  slug: string,
  timestamp = new Date(),
): string {
  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const d = String(timestamp.getUTCDate()).padStart(2, '0');
  return posix.join(ARTIFACT_SOURCE_PREFIX, String(y), m, d, `${slug}.md`);
}

export function resolveArtifactPath(relativePath: string): string {
  return resolve(GROUP_DIR, ...relativePath.split('/'));
}

function writeIpcTaskFile(payload: Record<string, unknown>): boolean {
  try {
    const tasksDir = resolve(IPC_DIR, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    const baseName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filePath = join(tasksDir, baseName);
    const tempPath = `${filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(payload), 'utf-8');
    renameSync(tempPath, filePath);
    return true;
  } catch {
    return false;
  }
}

export function queueGitHubArtifactExport(
  db: Database.Database,
  input: {
    artifactId: number;
    opportunityId: number;
    relativePath: string;
    repoBranch: string;
    repoUrl: string | null;
    runId: number;
  },
): GitHubExportState {
  if (!input.repoUrl) {
    return { status: 'disabled' };
  }

  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO artifact_exports (
      artifact_id,
      status,
      relative_path,
      repo_url,
      repo_branch,
      attempt_count,
      last_attempt_at_utc,
      commit_sha,
      last_error,
      created_at_utc,
      updated_at_utc
    )
    VALUES (?, 'pending', ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)
    ON CONFLICT(artifact_id) DO UPDATE SET
      status = CASE
        WHEN artifact_exports.status = 'succeeded' THEN artifact_exports.status
        ELSE 'pending'
      END,
      relative_path = excluded.relative_path,
      repo_url = excluded.repo_url,
      repo_branch = excluded.repo_branch,
      updated_at_utc = excluded.updated_at_utc,
      last_error = CASE
        WHEN artifact_exports.status = 'succeeded' THEN artifact_exports.last_error
        ELSE NULL
      END
  `,
  ).run(
    input.artifactId,
    input.relativePath,
    input.repoUrl,
    input.repoBranch,
    now,
    now,
  );

  const ipcWakeupSent = writeIpcTaskFile({
    artifactId: input.artifactId,
    type: 'artifact_export',
  });

  recordRunEvent(db, {
    eventType: 'artifact_export.queued',
    opportunityId: input.opportunityId,
    payload: {
      artifact_id: input.artifactId,
      ipc_wakeup_sent: ipcWakeupSent,
      relative_path: input.relativePath,
      repo_branch: input.repoBranch,
      repo_url: input.repoUrl,
    },
    runId: input.runId,
    stage: 'artifact',
    status: 'info',
    summary: 'Artifact export queued for host processing.',
  });

  return { status: 'queued' };
}
