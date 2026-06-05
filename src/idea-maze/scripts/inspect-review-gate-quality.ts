import { closeDb, getDb } from './lib/db.ts';
import { initSchema } from './lib/schema.ts';

function countByArchiveReason(db: ReturnType<typeof getDb>): Record<string, number> {
  const rows = db
    .prepare(
      `
      SELECT json_extract(metadata_json, '$.archive_reason') AS reason, COUNT(*) AS count
      FROM opportunities
      WHERE json_extract(metadata_json, '$.archive_reason') IS NOT NULL
      GROUP BY reason
      ORDER BY count DESC, reason ASC
    `,
    )
    .all() as { count: number; reason: string | null }[];
  return Object.fromEntries(rows.map((row) => [row.reason ?? 'unknown', row.count]));
}

function countByRejectionReason(db: ReturnType<typeof getDb>): Record<string, number> {
  const rows = db
    .prepare(
      `
      SELECT feature_value AS reason, COUNT(*) AS count
      FROM feedback_features
      WHERE feature_type = 'rejection_reason'
      GROUP BY feature_value
      ORDER BY count DESC, feature_value ASC
    `,
    )
    .all() as { count: number; reason: string }[];
  return Object.fromEntries(rows.map((row) => [row.reason, row.count]));
}

function scalarNumber(db: ReturnType<typeof getDb>, sql: string): number {
  return Number((db.prepare(sql).get() as { value: number | null }).value ?? 0);
}

function nullableScalarNumber(db: ReturnType<typeof getDb>, sql: string): number | null {
  const value = (db.prepare(sql).get() as { value: number | null }).value;
  return value === null || value === undefined ? null : Number(value);
}

function main() {
  const db = getDb();
  try {
    initSchema(db);
    const report = {
      archive_reason_counts: countByArchiveReason(db),
      average_final_score_recent_rejected_runs: nullableScalarNumber(
        db,
        `
        SELECT AVG(o.final_score) AS value
        FROM runs r
        JOIN opportunities o ON o.id = CAST(r.target_id AS INTEGER)
        WHERE r.status IN ('needs_more_evidence', 'error')
          AND r.started_at_utc >= datetime('now', '-30 days')
      `,
      ),
      fallback_template_runs: scalarNumber(
        db,
        `
        SELECT COUNT(*) AS value
        FROM runs
        WHERE json_extract(metadata_json, '$.prompt_metadata.validation_status') = 'fallback_template'
      `,
      ),
      pending_review_gate: scalarNumber(
        db,
        "SELECT COUNT(*) AS value FROM runs WHERE status = 'review_gate'",
      ),
      rejection_reason_counts: countByRejectionReason(db),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    closeDb();
  }
}

main();
