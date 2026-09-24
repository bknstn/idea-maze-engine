import type Database from 'better-sqlite3';

import {
  sampleSourceText,
  verifyEvidenceExcerpt,
  type EvidenceExcerptV1,
} from './evidence-excerpts.ts';
import type { SourceItemRow } from './queries.ts';

export type EvidenceExcerptCoverage = 'complete' | 'sampled' | 'unknown';
export type EvidenceExcerptStatus = 'verified' | 'no_grounded_evidence' | 'legacy' | 'stale';

export interface OpportunitySourceEvidence extends SourceItemRow {
  evidence_excerpts: EvidenceExcerptV1[];
  evidence_excerpt_coverage: EvidenceExcerptCoverage;
  evidence_excerpt_status: EvidenceExcerptStatus;
  invalid_evidence_excerpt_count: number;
}

interface InsightMetadataRow {
  source_item_id: number;
  metadata_json: string;
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

export function loadOpportunitySourceEvidence(
  db: Database.Database,
  opportunityId: number,
  limit?: number,
): OpportunitySourceEvidence[] {
  const limitClause = limit === undefined ? '' : 'LIMIT ?';
  const sourceRows = db.prepare(`
    SELECT si.*
    FROM source_items si
    JOIN opportunity_sources os ON os.source_item_id = si.id
    WHERE os.opportunity_id = ?
    ORDER BY json_extract(si.metadata_json, '$.harvest_score') DESC, si.timestamp_utc DESC
    ${limitClause}
  `).all(...(limit === undefined ? [opportunityId] : [opportunityId, limit])) as SourceItemRow[];
  if (!sourceRows.length) return [];

  const insightRows = db.prepare(`
    SELECT i.source_item_id, i.metadata_json
    FROM insights i
    JOIN opportunity_sources os ON os.source_item_id = i.source_item_id
    WHERE os.opportunity_id = ?
    ORDER BY i.id
  `).all(opportunityId) as InsightMetadataRow[];
  const bySource = new Map<number, InsightMetadataRow[]>();
  for (const row of insightRows) {
    const rows = bySource.get(row.source_item_id) ?? [];
    rows.push(row);
    bySource.set(row.source_item_id, rows);
  }

  return sourceRows.map((source) => {
    const metadataRows = bySource.get(source.id) ?? [];
    const excerpts: EvidenceExcerptV1[] = [];
    let sawExcerptContract = false;
    let sawExcerptCandidate = false;
    let sawSampledText = false;
    let invalidEvidenceExcerptCount = 0;

    for (const row of metadataRows) {
      const metadata = parseMetadata(row.metadata_json);
      if (metadata.evidence_excerpt_version === 1) sawExcerptContract = true;
      if (metadata.evidence_excerpt_coverage === 'sampled') sawSampledText = true;
      if (!Array.isArray(metadata.evidence_excerpts)) continue;
      for (const candidate of metadata.evidence_excerpts) {
        sawExcerptCandidate = true;
        const verified = verifyEvidenceExcerpt({
          sourceItemId: source.id,
          sourceText: source.text,
          excerpt: candidate,
        });
        if (!verified) {
          invalidEvidenceExcerptCount++;
          continue;
        }
        const key = `${verified.role}:${verified.startUtf16}:${verified.endUtf16}`;
        if (!excerpts.some((excerpt) => `${excerpt.role}:${excerpt.startUtf16}:${excerpt.endUtf16}` === key)) {
          excerpts.push(verified);
        }
      }
    }

    const coverage: EvidenceExcerptCoverage = sawExcerptContract
      ? sawSampledText ? 'sampled' : 'complete'
      : 'unknown';
    const status: EvidenceExcerptStatus = excerpts.length
      ? 'verified'
      : sawExcerptCandidate && invalidEvidenceExcerptCount > 0
        ? 'stale'
        : sawExcerptContract
          ? 'no_grounded_evidence'
          : 'legacy';

    return {
      ...source,
      evidence_excerpts: excerpts,
      evidence_excerpt_coverage: coverage,
      evidence_excerpt_status: status,
      invalid_evidence_excerpt_count: invalidEvidenceExcerptCount,
    };
  });
}

function excerptPriority(excerpt: EvidenceExcerptV1): number {
  return { pain: 0, workaround: 1, wtp: 2, time_loss: 3 }[excerpt.role];
}

function sourcePrefix(source: OpportunitySourceEvidence, budget: number): string {
  const base = `Source #${source.id} [${source.source}]`;
  const withUrl = source.canonical_url ? `${base} URL=${source.canonical_url}` : base;
  return withUrl.length <= Math.max(0, budget - 80) ? withUrl : base;
}

/**
 * Format a compact research context. A verified quote is never clipped; when
 * none is available, any body sample is labeled unverified context.
 */
export function formatSourceEvidence(
  source: OpportunitySourceEvidence,
  maxChars = 600,
): string {
  const budget = Math.max(0, Math.floor(maxChars));
  if (!budget) return '';
  const prefix = sourcePrefix(source, budget);
  const orderedExcerpts = [...source.evidence_excerpts]
    .sort((a, b) => excerptPriority(a) - excerptPriority(b) || a.startUtf16 - b.startUtf16);
  const preferredByRole = (['pain', 'workaround', 'wtp', 'time_loss'] as const)
    .flatMap((role) => orderedExcerpts.find((excerpt) => excerpt.role === role) ?? []);
  const preferredSet = new Set(preferredByRole);
  const excerpts = [...preferredByRole, ...orderedExcerpts.filter((excerpt) => !preferredSet.has(excerpt))];

  if (excerpts.length) {
    const selected: EvidenceExcerptV1[] = [];
    const omittedRoles: EvidenceExcerptV1['role'][] = [];
    let fixedLength = prefix.length + 1;
    for (const excerpt of excerpts) {
      const line = `Verified ${excerpt.role} excerpt (${excerpt.startUtf16}..${excerpt.endUtf16}):\n⟦${excerpt.quote}⟧`;
      const separatorLength = selected.length ? 1 : 0;
      if (fixedLength + separatorLength + line.length <= budget) {
        selected.push(excerpt);
        fixedLength += separatorLength + line.length;
      } else {
        omittedRoles.push(excerpt.role);
      }
    }
    if (selected.length) {
      let omittedNote = omittedRoles.length
        ? `\nVerified roles omitted by prompt budget: ${[...new Set(omittedRoles)].join(', ')}.`
        : '';
      if (fixedLength + omittedNote.length > budget) omittedNote = '';
      const contextBudget = Math.max(0, Math.min(120, budget - fixedLength - omittedNote.length));
      const perExcerptContext = selected.length ? Math.floor(contextBudget / selected.length) : 0;
      const lines = selected.map((excerpt) => {
        const beforeBudget = Math.floor(perExcerptContext / 2);
        const afterBudget = perExcerptContext - beforeBudget;
        const before = source.text.slice(Math.max(0, excerpt.startUtf16 - beforeBudget), excerpt.startUtf16);
        const after = source.text.slice(excerpt.endUtf16, excerpt.endUtf16 + afterBudget);
        return `Verified ${excerpt.role} excerpt (${excerpt.startUtf16}..${excerpt.endUtf16}):\n${before}⟦${excerpt.quote}⟧${after}`;
      });
      const formatted = `${prefix}\n${lines.join('\n')}${omittedNote}`;
      if (formatted.length <= budget) return formatted;
      const withoutContext = selected.map((excerpt) =>
        `Verified ${excerpt.role} excerpt (${excerpt.startUtf16}..${excerpt.endUtf16}):\n⟦${excerpt.quote}⟧`,
      ).join('\n');
      const minimal = `${prefix}\n${withoutContext}${omittedNote}`;
      return minimal.length <= budget ? minimal : `${prefix}\n${withoutContext}`;
    }

    const roles = [...new Set(excerpts.map((excerpt) => excerpt.role))].join(', ');
    const oversize = `${prefix}\nVerified ${roles} excerpt omitted as a whole because it could not fit this prompt budget.`;
    return oversize.length <= budget ? oversize : prefix.slice(0, budget);
  }

  const label = source.evidence_excerpt_status === 'stale'
    ? 'Stored excerpt failed source-text revalidation; no quote is verified.'
    : source.evidence_excerpt_status === 'no_grounded_evidence'
      ? source.evidence_excerpt_coverage === 'sampled'
        ? 'Extraction found no grounded quote; only a partial source sample was analyzed.'
        : 'Extraction found no grounded quote; no quote is verified.'
      : source.evidence_excerpt_status === 'verified'
        ? 'Verified quote metadata is unavailable; no quote is verified.'
        : 'Legacy source has no stored verified excerpt.';
  const contextLabel = 'Unverified context only:';
  let textBudget = Math.max(3, budget - prefix.length - label.length - contextLabel.length - 4);
  let sample = sampleSourceText(source.text, textBudget);
  let formatted = `${prefix}\n${label}\n${contextLabel}\n${sample.formatted}`;
  while (formatted.length > budget && textBudget > 3) {
    textBudget = Math.max(3, textBudget - (formatted.length - budget));
    sample = sampleSourceText(source.text, textBudget);
    formatted = `${prefix}\n${label}\n${contextLabel}\n${sample.formatted}`;
  }
  if (formatted.length <= budget) return formatted;
  const status = `${prefix}\n${label}`;
  return status.length <= budget ? status : prefix.slice(0, budget);
}
