import type Database from 'better-sqlite3';

import { groundEvidenceExcerpts } from './evidence-extraction.ts';
import type { EvidenceExcerptRole, SourceTextWindow } from './evidence-excerpts.ts';

interface LegacyInsightRow {
  id: number;
  source_item_id: number;
  metadata_json: string;
  source_text: string;
}

export interface EvidenceExcerptBackfillResult {
  dryRun: boolean;
  excerptsCreated: number;
  excerptsRejected: number;
  rowsNeedingBackfill: number;
  rowsSkippedMalformed: number;
  rowsScanned: number;
  rowsUpdated: number;
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function legacyCandidates(metadata: Record<string, unknown>): Array<{ role: EvidenceExcerptRole; quote: string }> {
  const candidates: Array<{ role: EvidenceExcerptRole; quote: string }> = [];
  const fieldRoles: Array<[EvidenceExcerptRole, string[]]> = [
    ['pain', ['pain_point', 'pain_quote']],
    ['workaround', ['current_workaround', 'workaround', 'workaround_quote']],
    ['wtp', ['willingness_to_pay', 'wtp', 'wtp_quote']],
    ['time_loss', ['time_loss', 'time_loss_quote']],
  ];
  for (const [role, fields] of fieldRoles) {
    for (const field of fields) {
      const value = metadata[field];
      if (typeof value === 'string' && value.trim()) candidates.push({ role, quote: value });
    }
  }
  if (Array.isArray(metadata.evidence_excerpts)) {
    for (const value of metadata.evidence_excerpts) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.role === 'string' && typeof candidate.quote === 'string') {
        candidates.push({ role: candidate.role as EvidenceExcerptRole, quote: candidate.quote });
      }
    }
  }
  return candidates;
}

/**
 * Ground matching legacy metadata locally, without an LLM call. Legacy harvest
 * batches saw only the first 1,500 UTF-16 units, so backfill never searches
 * beyond that historical visible range.
 */
export function backfillEvidenceExcerpts(
  db: Database.Database,
  options: { apply?: boolean; limit?: number } = {},
): EvidenceExcerptBackfillResult {
  const limit = options.limit === undefined ? 100 : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('Evidence excerpt backfill limit must be a non-negative safe integer.');
  }
  const rowsNeedingBackfill = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM insights i
    JOIN source_items si ON si.id = i.source_item_id
    WHERE CASE
      WHEN json_valid(i.metadata_json) THEN CASE
        WHEN json_type(i.metadata_json) = 'object'
          THEN COALESCE(json_extract(i.metadata_json, '$.evidence_excerpt_version'), 0) != 1
        ELSE 0
      END
      ELSE 0
    END
  `).get() as { count: number }).count;
  const rowsSkippedMalformed = (db.prepare(`
    SELECT COUNT(*) AS count
    FROM insights i
    JOIN source_items si ON si.id = i.source_item_id
    WHERE CASE
      WHEN json_valid(i.metadata_json) THEN json_type(i.metadata_json) != 'object'
      ELSE 1
    END
  `).get() as { count: number }).count;
  const limitClause = 'LIMIT ?';
  const params = [limit];
  const selected = db.prepare(`
    SELECT i.id, i.source_item_id, i.metadata_json, si.text AS source_text
    FROM insights i
    JOIN source_items si ON si.id = i.source_item_id
    WHERE CASE
      WHEN json_valid(i.metadata_json) THEN CASE
        WHEN json_type(i.metadata_json) = 'object'
          THEN COALESCE(json_extract(i.metadata_json, '$.evidence_excerpt_version'), 0) != 1
        ELSE 0
      END
      ELSE 0
    END
    ORDER BY i.id
    ${limitClause}
  `).all(...params) as LegacyInsightRow[];
  let excerptsCreated = 0;
  let excerptsRejected = 0;
  const updates = selected.map((row) => {
    const metadata = parseMetadata(row.metadata_json);
    const endUtf16 = Math.min(1500, row.source_text.length);
    const visibleRanges: SourceTextWindow[] = [{
      startUtf16: 0,
      endUtf16,
      text: row.source_text.slice(0, endUtf16),
    }];
    const candidates = legacyCandidates(metadata);
    const grounded = groundEvidenceExcerpts(row.source_item_id, row.source_text, candidates, visibleRanges);
    excerptsCreated += grounded.excerpts.length;
    excerptsRejected += grounded.rejectedCount;
    return {
      id: row.id,
      metadata: {
        ...metadata,
        evidence_excerpt_version: 1,
        evidence_excerpt_coverage: row.source_text.length <= 1500 ? 'complete' : 'sampled',
        evidence_excerpt_status: grounded.excerpts.length ? 'verified' : 'no_grounded_evidence',
        evidence_excerpt_backfill: 'legacy_metadata_exact_match_v1',
        evidence_excerpt_candidate_count: grounded.candidateCount,
        evidence_excerpt_rejected_count: grounded.rejectedCount,
        evidence_excerpts: grounded.excerpts,
      },
    };
  });

  if (options.apply) {
    const update = db.prepare('UPDATE insights SET metadata_json = ? WHERE id = ?');
    const applyUpdates = db.transaction(() => {
      for (const row of updates) update.run(JSON.stringify(row.metadata), row.id);
    });
    applyUpdates();
  }

  return {
    dryRun: !options.apply,
    excerptsCreated,
    excerptsRejected,
    rowsNeedingBackfill,
    rowsSkippedMalformed,
    rowsScanned: selected.length,
    rowsUpdated: options.apply ? updates.length : 0,
  };
}
