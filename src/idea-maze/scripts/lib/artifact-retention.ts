import type Database from 'better-sqlite3';

export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;

export function parseArtifactRetentionDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ARTIFACT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('retention days must be a non-negative number');
  }
  return parsed;
}

export interface ArtifactRetentionCandidate {
  artifact_id: number;
  created_at_utc: string;
  kind: 'artifact' | 'exploration';
  lifecycle_stage: string;
  opportunity_slug: string;
  opportunity_title: string;
  path: string;
  run_id: number;
  status: string;
}

export interface ArtifactRetentionReport {
  candidates: ArtifactRetentionCandidate[];
  cutoff_utc: string;
  eligible_artifacts: number;
  eligible_count: number;
  eligible_explorations: number;
  eligible_files: number;
  retention_days: number;
}

export function inspectArtifactRetention(
  db: Database.Database,
  options: {
    now?: Date;
    retentionDays?: number;
  } = {},
): ArtifactRetentionReport {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    throw new Error('retentionDays must be a non-negative number');
  }

  const cutoffUtc = new Date(
    now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const candidates = db
    .prepare(
      `
      SELECT
        'artifact' AS kind,
        a.id AS artifact_id,
        a.run_id,
        a.path,
        a.created_at_utc,
        o.slug AS opportunity_slug,
        o.title AS opportunity_title,
        o.lifecycle_stage,
        o.status
      FROM artifacts a
      JOIN opportunities o ON o.id = a.opportunity_id
      WHERE a.created_at_utc <= ?
        AND o.status = 'archived'
        AND o.lifecycle_stage <> 'approved'

      UNION ALL

      SELECT
        'exploration' AS kind,
        e.id AS artifact_id,
        e.run_id,
        e.path,
        e.created_at_utc,
        o.slug AS opportunity_slug,
        o.title AS opportunity_title,
        o.lifecycle_stage,
        o.status
      FROM exploration_artifacts e
      JOIN opportunities o ON o.id = e.opportunity_id
      WHERE e.created_at_utc <= ?
        AND o.status = 'archived'
        AND o.lifecycle_stage <> 'approved'

      ORDER BY 5 ASC, 1 ASC, 2 ASC
    `,
    )
    .all(cutoffUtc, cutoffUtc) as ArtifactRetentionCandidate[];

  return {
    candidates,
    cutoff_utc: cutoffUtc,
    eligible_artifacts: candidates.filter((item) => item.kind === 'artifact').length,
    eligible_count: candidates.length,
    eligible_explorations: candidates.filter(
      (item) => item.kind === 'exploration',
    ).length,
    eligible_files: new Set(candidates.map((item) => item.path)).size,
    retention_days: retentionDays,
  };
}
