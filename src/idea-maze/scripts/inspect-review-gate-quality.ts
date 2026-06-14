import { closeDb, getDb } from './lib/db.ts';
import { evaluateEvidenceQuality, type EvidenceSourceSummary } from './lib/evidence-quality.ts';
import { AUTO_PUBLISH_MIN_BUCKET } from './lib/opportunity-policy.ts';
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

function fetchOpportunitySources(
  db: ReturnType<typeof getDb>,
  opportunityId: number,
): EvidenceSourceSummary[] {
  return db
    .prepare(
      `
      SELECT si.id, si.source, si.title, si.text, si.canonical_url,
             si.channel_or_label, si.content_hash, si.metadata_json
      FROM source_items si
      JOIN opportunity_sources os ON os.source_item_id = si.id
      WHERE os.opportunity_id = ?
      ORDER BY si.source ASC, si.timestamp_utc DESC
    `,
    )
    .all(opportunityId) as EvidenceSourceSummary[];
}

function reviewCandidateDispositions(db: ReturnType<typeof getDb>): Record<string, number> {
  const candidates = db
    .prepare(
      `
      SELECT DISTINCT o.id, o.final_score
      FROM opportunities o
      LEFT JOIN runs r ON r.target_id = CAST(o.id AS TEXT)
      WHERE o.status = 'active'
        AND (
          o.final_score >= ?
          OR r.status IN ('draft_ready', 'review_gate')
        )
    `,
    )
    .all(AUTO_PUBLISH_MIN_BUCKET) as { final_score: number; id: number }[];

  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    const quality = evaluateEvidenceQuality(fetchOpportunitySources(db, candidate.id), {
      finalScore: Number(candidate.final_score),
      validationStatus: null,
    });
    counts[quality.disposition] = (counts[quality.disposition] ?? 0) + 1;
    for (const reason of quality.reasons) {
      counts[`reason:${reason}`] = (counts[`reason:${reason}`] ?? 0) + 1;
    }
  }
  return counts;
}

function topRepeatedSourceRefs(db: ReturnType<typeof getDb>, limit = 10): { count: number; ref: string }[] {
  return db
    .prepare(
      `
      SELECT COALESCE(si.canonical_url, si.source || ':' || si.external_id) AS ref,
             COUNT(DISTINCT os.opportunity_id) AS count
      FROM opportunity_sources os
      JOIN source_items si ON si.id = os.source_item_id
      GROUP BY ref
      HAVING count > 1
      ORDER BY count DESC, ref ASC
      LIMIT ?
    `,
    )
    .all(limit) as { count: number; ref: string }[];
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
      review_candidate_dispositions: reviewCandidateDispositions(db),
      top_repeated_source_refs: topRepeatedSourceRefs(db),
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    closeDb();
  }
}

main();
