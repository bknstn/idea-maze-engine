import type Database from 'better-sqlite3';

import {
  buildAssessmentCacheKey,
  buildRequestBody,
  DEFAULT_EVIDENCE_ASSESSMENT_BUDGET,
  estimateInputTokens,
  validateCandidate,
  type DimensionAssessment,
  type EvidenceAssessmentCandidate,
  type EvidenceAssessmentOutcome,
} from './evidence-assessor.ts';
import { createTypeSafeEvidenceAssessor } from './evidence-assessor-typesafe.ts';
import { hashSourceText, type EvidenceExcerptRole } from './evidence-excerpts.ts';
import {
  formatSourceEvidence,
  type OpportunitySourceEvidence,
} from './source-evidence.ts';

export const JEV_SHADOW_RUBRIC_VERSION = 'idea-maze-jev-shadow-v1';

const CACHE_KEY_PREFIX = 'research:jev-shadow:v1:';

const QUESTIONS: EvidenceAssessmentCandidate['questions'] = [
  {
    id: 'tailquote_grounding',
    dimension: 'tailquote',
    instructions: 'Does a verified source excerpt directly support the specific opportunity thesis for this source?',
    trueMeans: 'The exact verified excerpt directly states the claimed pain, workaround, time loss, or willingness to pay.',
    falseMeans: 'The excerpt is missing, unrelated, inferred, or does not support the specific thesis.',
  },
  {
    id: 'workaround_signal',
    dimension: 'workaround',
    instructions: 'Does the verified source excerpt describe a current manual workaround or failed alternative?',
    trueMeans: 'A buyer describes a concrete workaround or an inadequate existing alternative.',
    falseMeans: 'No concrete workaround or inadequacy is present in the verified excerpt.',
  },
  {
    id: 'contradiction_signal',
    dimension: 'contradiction',
    instructions: 'Does the verified source excerpt directly contradict the opportunity thesis?',
    trueMeans: 'The source states the claimed pain is absent, unimportant, or already adequately solved.',
    falseMeans: 'The source does not directly contradict the opportunity thesis.',
  },
];

interface JevTraceEntry {
  source_item_id: number;
  full_source_version_hash: string;
  cache_key: string | null;
  requested_model: string | null;
  returned_model: string | null;
  rubric_version: string;
  status: string;
  cache_hit: boolean;
  usage_source: 'provider_call' | 'cached_original' | 'not_available';
  cache_read_failed: boolean;
  cache_write_failed: boolean;
  reason: string | null;
  dimensions: DimensionAssessment[];
  usage: { input_tokens: number | null; output_tokens: number | null };
  estimated_input_tokens: number | null;
  client_latency_ms: number | null;
  http_status: number | null;
}

export interface JevShadowResearchTrace {
  mode: 'shadow';
  enabled: boolean;
  applied_to_decision: false;
  reason: string | null;
  requested_model: string | null;
  rubric_version: string;
  eligible_source_count: number;
  excluded_discovery_source_count: number;
  missing_verified_excerpt_count: number;
  assessed_count: number;
  cache_hits: number;
  cache_read_failures: number;
  cache_write_failures: number;
  error_count: number;
  skipped_count: number;
  token_usage: { input_tokens: number | null; output_tokens: number | null };
  estimated_input_tokens: number | null;
  client_latency_ms: number | null;
  entries: JevTraceEntry[];
}

interface CachedAssessmentV1 {
  version: 1;
  source_item_id: number;
  full_source_version_hash: string;
  cache_key: string;
  requested_model: string;
  returned_model: string;
  rubric_version: string;
  dimensions: DimensionAssessment[];
  usage: { input_tokens: number | null; output_tokens: number | null };
  estimated_input_tokens: number | null;
  client_latency_ms: number | null;
}

interface CandidateRecord {
  source: OpportunitySourceEvidence;
  candidate: EvidenceAssessmentCandidate;
  fullSourceVersionHash: string;
  cacheKey: string;
  estimatedInputTokens: number;
  cacheReadFailed: boolean;
}

interface CachedAssessmentRead {
  entry: JevTraceEntry | null;
  failed: boolean;
}

export async function assessResearchEvidenceWithJev(
  db: Database.Database,
  opportunity: { title: string; thesis: string; cluster_key: string },
  sourceItems: OpportunitySourceEvidence[],
): Promise<JevShadowResearchTrace> {
  const assessor = createTypeSafeEvidenceAssessor();
  const requestedModel = assessor.requestedModel();
  const eligible = sourceItems.filter((source) => source.source !== 'search' && source.evidence_excerpt_status === 'verified' && source.evidence_excerpts.length > 0);
  const excludedDiscovery = sourceItems.filter((source) => source.source === 'search').length;
  const missingExcerptCount = sourceItems.filter((source) => source.source !== 'search' && source.evidence_excerpts.length === 0).length;

  if (!assessor.isEnabled()) {
    return emptyTrace({
      enabled: false,
      reason: process.env.IDEA_MAZE_JEV_ENABLED?.trim().toLowerCase() !== 'true'
        ? 'disabled_by_default_or_flag'
        : !process.env.TYPESAFE_API_KEY?.trim() ? 'missing_api_key' : 'missing_explicit_model',
      requestedModel,
      eligibleSourceCount: eligible.length,
      excludedDiscoverySourceCount: excludedDiscovery,
      missingVerifiedExcerptCount: missingExcerptCount,
    });
  }

  const cache = new Map<number, JevTraceEntry>();
  const misses: CandidateRecord[] = [];
  for (const source of eligible) {
    const fullSourceVersionHash = hashSourceText(source.text);
    const candidate = buildCandidate(source, opportunity, fullSourceVersionHash);
    try {
      validateCandidate(candidate);
      const cacheKey = buildAssessmentCacheKey({
        state: candidate.state,
        questions: candidate.questions,
        rubricVersion: candidate.rubricVersion,
        requestedModel: requestedModel!,
      });
      const estimatedInputTokens = estimateInputTokens(buildRequestBody(candidate, requestedModel!));
      const cacheRead = readCachedAssessment(db, {
        sourceItemId: source.id,
        fullSourceVersionHash,
        cacheKey,
        requestedModel: requestedModel!,
        rubricVersion: candidate.rubricVersion,
      });
      if (cacheRead.entry) {
        cache.set(source.id, cacheRead.entry);
      } else {
        misses.push({ source, candidate, fullSourceVersionHash, cacheKey, estimatedInputTokens, cacheReadFailed: cacheRead.failed });
      }
    } catch {
      cache.set(source.id, unknownEntry(source.id, fullSourceVersionHash, requestedModel, 'invalid_request'));
    }
  }

  let outcomes: EvidenceAssessmentOutcome[] = [];
  if (misses.length) {
    try {
      outcomes = await assessor.assessBatch(misses.map((record) => record.candidate), DEFAULT_EVIDENCE_ASSESSMENT_BUDGET);
    } catch {
      outcomes = misses.map((record) => unknownOutcome(record, requestedModel, 'assessment_failed'));
    }
  }

  for (const record of misses) {
    const outcome = outcomes.find((item) => item.candidateId === record.candidate.candidateId)
      ?? unknownOutcome(record, requestedModel, 'missing_assessment_result');
    const entry = toTraceEntry(record, outcome, false);
    cache.set(record.source.id, entry);
    if (isCacheable(record, outcome)) {
      try {
        writeCachedAssessment(db, record, outcome);
      } catch {
        entry.cache_write_failed = true;
      }
    }
  }

  const entries = eligible.map((source) => cache.get(source.id) ?? unknownEntry(
    source.id,
    hashSourceText(source.text),
    requestedModel,
    'missing_assessment_result',
  ));
  return summarizeTrace({
    enabled: true,
    requestedModel,
    eligibleSourceCount: eligible.length,
    excludedDiscoverySourceCount: excludedDiscovery,
    missingVerifiedExcerptCount: missingExcerptCount,
    entries,
  });
}

function buildCandidate(
  source: OpportunitySourceEvidence,
  opportunity: { title: string; thesis: string; cluster_key: string },
  fullSourceVersionHash: string,
): EvidenceAssessmentCandidate {
  return {
    candidateId: String(source.id),
    state: {
      sourceItemId: source.id,
      sourceType: source.source,
      fullSourceVersionHash,
      opportunity: {
        title: opportunity.title,
        thesis: opportunity.thesis,
        clusterKey: opportunity.cluster_key,
      },
      verifiedExcerpts: source.evidence_excerpts.map((excerpt) => ({
        role: excerpt.role as EvidenceExcerptRole,
        quote: excerpt.quote,
        startUtf16: excerpt.startUtf16,
        endUtf16: excerpt.endUtf16,
      })),
      excerptCoverage: source.evidence_excerpt_coverage,
      // formatSourceEvidence labels verified quotes and any surrounding body sample explicitly.
      formattedEvidenceContext: formatSourceEvidence(source, 1_800),
    },
    rubricVersion: JEV_SHADOW_RUBRIC_VERSION,
    questions: QUESTIONS,
  };
}

function readCachedAssessment(db: Database.Database, expected: {
  sourceItemId: number;
  fullSourceVersionHash: string;
  cacheKey: string;
  requestedModel: string;
  rubricVersion: string;
}): CachedAssessmentRead {
  try {
    const row = db.prepare('SELECT value_json FROM app_state WHERE key = ?')
      .get(`${CACHE_KEY_PREFIX}${expected.cacheKey}`) as { value_json: string } | undefined;
    if (!row) return { entry: null, failed: false };
    const cached = JSON.parse(row.value_json) as CachedAssessmentV1;
    if (
      cached.version !== 1 ||
      cached.source_item_id !== expected.sourceItemId ||
      cached.full_source_version_hash !== expected.fullSourceVersionHash ||
      cached.cache_key !== expected.cacheKey ||
      cached.requested_model !== expected.requestedModel ||
      cached.rubric_version !== expected.rubricVersion ||
      typeof cached.returned_model !== 'string' || !cached.returned_model ||
      !validDimensions(cached.dimensions) ||
      !validNullableMetric(cached.usage?.input_tokens) ||
      !validNullableMetric(cached.usage?.output_tokens) ||
      !validNullableMetric(cached.estimated_input_tokens) ||
      !validNullableMetric(cached.client_latency_ms)
    ) return { entry: null, failed: true };
    return { entry: {
      source_item_id: cached.source_item_id,
      full_source_version_hash: cached.full_source_version_hash,
      cache_key: cached.cache_key,
      requested_model: cached.requested_model,
      returned_model: cached.returned_model,
      rubric_version: cached.rubric_version,
      status: 'complete',
      cache_hit: true,
      usage_source: 'cached_original',
      cache_read_failed: false,
      cache_write_failed: false,
      reason: null,
      dimensions: cached.dimensions,
      usage: cached.usage,
      estimated_input_tokens: cached.estimated_input_tokens,
      client_latency_ms: cached.client_latency_ms,
      http_status: 200,
    }, failed: false };
  } catch {
    return { entry: null, failed: true };
  }
}

function writeCachedAssessment(
  db: Database.Database,
  record: CandidateRecord,
  outcome: EvidenceAssessmentOutcome,
): void {
  const cacheValue: CachedAssessmentV1 = {
    version: 1,
    source_item_id: record.source.id,
    full_source_version_hash: record.fullSourceVersionHash,
    cache_key: record.cacheKey,
    requested_model: outcome.requestedModel!,
    returned_model: outcome.returnedModel!,
    rubric_version: record.candidate.rubricVersion,
    dimensions: outcome.assessments,
    usage: { input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens },
    estimated_input_tokens: outcome.estimatedInputTokens,
    client_latency_ms: outcome.latencyMs,
  };
  db.prepare(`
    INSERT INTO app_state (key, value_json, updated_at_utc)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_utc = excluded.updated_at_utc
  `).run(`${CACHE_KEY_PREFIX}${record.cacheKey}`, JSON.stringify(cacheValue), new Date().toISOString());
}

function validDimensions(value: unknown): value is DimensionAssessment[] {
  return Array.isArray(value) && value.length === QUESTIONS.length && value.every((dimension, index) =>
    dimension?.id === QUESTIONS[index].id &&
    dimension.dimension === QUESTIONS[index].dimension &&
    dimension.status === 'scored' &&
    typeof dimension.noul === 'number' && Number.isFinite(dimension.noul) && dimension.noul >= 0 && dimension.noul <= 1,
  );
}

function isCacheable(record: CandidateRecord, outcome: EvidenceAssessmentOutcome): boolean {
  return outcome.status === 'complete' &&
    typeof outcome.requestedModel === 'string' && outcome.requestedModel.length > 0 &&
    outcome.assessments.length === QUESTIONS.length &&
    outcome.assessments.every((dimension) => dimension.status === 'scored' && dimension.noul !== null) &&
    outcome.returnedModel !== null &&
    outcome.cacheKey === record.cacheKey;
}

function toTraceEntry(
  record: CandidateRecord,
  outcome: EvidenceAssessmentOutcome,
  cacheHit: boolean,
): JevTraceEntry {
  return {
    source_item_id: record.source.id,
    full_source_version_hash: record.fullSourceVersionHash,
    cache_key: record.cacheKey,
    requested_model: outcome.requestedModel,
    returned_model: outcome.returnedModel,
    rubric_version: record.candidate.rubricVersion,
    status: outcome.status,
    cache_hit: cacheHit,
    usage_source: cacheHit ? 'cached_original' : outcome.latencyMs !== null ? 'provider_call' : 'not_available',
    cache_read_failed: record.cacheReadFailed,
    cache_write_failed: false,
    reason: outcome.reason,
    dimensions: outcome.assessments,
    usage: { input_tokens: outcome.usage.inputTokens, output_tokens: outcome.usage.outputTokens },
    estimated_input_tokens: outcome.estimatedInputTokens ?? record.estimatedInputTokens,
    client_latency_ms: outcome.latencyMs,
    http_status: outcome.httpStatus,
  };
}

function unknownOutcome(
  record: CandidateRecord,
  requestedModel: string | null,
  reason: string,
): EvidenceAssessmentOutcome {
  return {
    candidateId: record.candidate.candidateId,
    candidateState: record.candidate.state,
    mode: 'shadow',
    appliedToDecision: false,
    status: 'error',
    cacheHit: false,
    reason,
    requestedModel,
    returnedModel: null,
    cacheKey: record.cacheKey,
    rubricVersion: record.candidate.rubricVersion,
    assessments: record.candidate.questions.map((question) => ({
      id: question.id,
      dimension: question.dimension,
      status: 'unknown',
      noul: null,
    })),
    usage: { inputTokens: null, outputTokens: null },
    estimatedInputTokens: record.estimatedInputTokens,
    latencyMs: null,
    httpStatus: null,
    retryable: false,
  };
}

function unknownEntry(
  sourceItemId: number,
  fullSourceVersionHash: string,
  requestedModel: string | null,
  reason: string,
): JevTraceEntry {
  return {
    source_item_id: sourceItemId,
    full_source_version_hash: fullSourceVersionHash,
    cache_key: null,
    requested_model: requestedModel,
    returned_model: null,
    rubric_version: JEV_SHADOW_RUBRIC_VERSION,
    status: 'unknown',
    cache_hit: false,
    usage_source: 'not_available',
    cache_read_failed: false,
    cache_write_failed: false,
    reason,
    dimensions: QUESTIONS.map((question) => ({ id: question.id, dimension: question.dimension, status: 'unknown', noul: null })),
    usage: { input_tokens: null, output_tokens: null },
    estimated_input_tokens: null,
    client_latency_ms: null,
    http_status: null,
  };
}

function emptyTrace(args: {
  enabled: boolean;
  reason: string | null;
  requestedModel: string | null;
  eligibleSourceCount: number;
  excludedDiscoverySourceCount: number;
  missingVerifiedExcerptCount: number;
}): JevShadowResearchTrace {
  return {
    mode: 'shadow',
    enabled: args.enabled,
    applied_to_decision: false,
    reason: args.reason,
    requested_model: args.requestedModel,
    rubric_version: JEV_SHADOW_RUBRIC_VERSION,
    eligible_source_count: args.eligibleSourceCount,
    excluded_discovery_source_count: args.excludedDiscoverySourceCount,
    missing_verified_excerpt_count: args.missingVerifiedExcerptCount,
    assessed_count: 0,
    cache_hits: 0,
    cache_read_failures: 0,
    cache_write_failures: 0,
    error_count: 0,
    skipped_count: args.eligibleSourceCount,
    token_usage: { input_tokens: null, output_tokens: null },
    estimated_input_tokens: null,
    client_latency_ms: null,
    entries: [],
  };
}

function summarizeTrace(args: {
  enabled: boolean;
  requestedModel: string | null;
  eligibleSourceCount: number;
  excludedDiscoverySourceCount: number;
  missingVerifiedExcerptCount: number;
  entries: JevTraceEntry[];
}): JevShadowResearchTrace {
  const attemptedEntries = args.entries.filter((entry) => entry.usage_source === 'provider_call');
  const inputUsage = sumNullable(attemptedEntries.map((entry) => entry.usage.input_tokens));
  const outputUsage = sumNullable(attemptedEntries.map((entry) => entry.usage.output_tokens));
  const estimatedInputs = sumNullable(attemptedEntries.map((entry) => entry.estimated_input_tokens));
  const clientLatency = sumNullable(args.entries.filter((entry) => !entry.cache_hit).map((entry) => entry.client_latency_ms));
  const assessedCount = args.entries.filter((entry) => entry.status === 'complete' || entry.status === 'partial' || entry.status === 'unknown').length;
  const errorCount = args.entries.filter((entry) => entry.status === 'error').length;
  const skippedCount = args.entries.filter((entry) => entry.status === 'skipped_budget').length;
  return {
    mode: 'shadow',
    enabled: args.enabled,
    applied_to_decision: false,
    reason: null,
    requested_model: args.requestedModel,
    rubric_version: JEV_SHADOW_RUBRIC_VERSION,
    eligible_source_count: args.eligibleSourceCount,
    excluded_discovery_source_count: args.excludedDiscoverySourceCount,
    missing_verified_excerpt_count: args.missingVerifiedExcerptCount,
    assessed_count: assessedCount,
    cache_hits: args.entries.filter((entry) => entry.cache_hit).length,
    cache_read_failures: args.entries.filter((entry) => entry.cache_read_failed).length,
    cache_write_failures: args.entries.filter((entry) => entry.cache_write_failed).length,
    error_count: errorCount,
    skipped_count: skippedCount,
    token_usage: { input_tokens: inputUsage, output_tokens: outputUsage },
    estimated_input_tokens: estimatedInputs,
    client_latency_ms: clientLatency,
    entries: args.entries,
  };
}

function sumNullable(values: Array<number | null>): number | null {
  if (!values.length || values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null;
  return values.reduce((sum, value) => sum + (value as number), 0);
}

function validNullableMetric(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}
