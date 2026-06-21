import type Database from 'better-sqlite3';

import { getCounts } from './queries.ts';
import {
  computeTasteForOpportunity,
  extractOpportunityFeatures,
  type MatchedTasteFeature,
  type OpportunityFeatureSnapshot,
} from './taste.ts';

function parseJson(value: string): Record<string, any> {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function formatLifecycleStage(stage: string): string {
  switch (stage) {
    case 'approved':
      return 'artifact';
    case 'review_gate':
      return 'researching';
    case 'rejected':
      return 'archived';
    default:
      return stage;
  }
}

export interface PipelineStatusSnapshot {
  active_opportunities: number;
  archived_opportunities: number;
  counts: ReturnType<typeof getCounts>;
  latest_run: {
    completed_at_utc: string | null;
    error: string | null;
    id: number;
    started_at_utc: string;
    status: string;
  } | null;
  recent_warnings: Array<{
    created_at_utc: string;
    failure_class: string | null;
    payload: Record<string, any>;
    run_id: number | null;
    stage: string | null;
    status: string;
    summary: string;
  }>;
  stages: Array<{
    created_at_utc: string;
    duration_ms: number | null;
    payload: Record<string, any>;
    stage: string | null;
    status: string;
    summary: string;
  }>;
}

export interface LatestSnapshot {
  artifacts: Array<{
    created_at_utc: string;
    id: number;
    opportunity_slug: string | null;
    opportunity_title: string | null;
    path: string;
    run_id: number;
  }>;
  opportunities: Array<{
    final_score: number;
    lifecycle_stage: string;
    slug: string;
    status: string;
    title: string;
    updated_at_utc: string;
  }>;
  runs: Array<{
    completed_at_utc: string | null;
    id: number;
    run_type: string;
    started_at_utc: string;
    status: string;
    target_id: string | null;
    target_type: string;
  }>;
}

export interface ArtifactsSnapshot {
  artifacts: Array<{
    approved_at_utc: string | null;
    created_at_utc: string;
    export_attempt_count: number | null;
    export_commit_sha: string | null;
    export_last_error: string | null;
    export_status: string | null;
    id: number;
    opportunity_slug: string;
    opportunity_title: string;
    path: string;
    relative_path: string | null;
    run_id: number;
  }>;
}

export interface OpportunityExplanationSnapshot {
  artifact_history: Array<{ created_at_utc: string; path: string }>;
  cluster_key: string;
  evidence: {
    insight_count: number;
    source_count: number;
    source_summary: Array<{ count: number; source: string }>;
    top_harvest_signals: string[];
    top_source_patterns: string[];
  };
  feature_snapshot: OpportunityFeatureSnapshot;
  lifecycle: string;
  opportunity: {
    id: number;
    slug: string;
    status: string;
    thesis: string;
    title: string;
  };
  scores: {
    final: number;
    market: number;
    taste: number;
  };
  taste_match: {
    founder_preference_adjustment: number;
    founder_preference_signals: Array<{ score: number; signal: string }>;
    learned_adjustment: number;
    matched_features: MatchedTasteFeature[];
    type_scores: Record<string, number>;
  };
}

export function buildPipelineStatusSnapshot(
  db: Database.Database,
): PipelineStatusSnapshot {
  const latestRun = db
    .prepare(
      `
    SELECT id, status, started_at_utc, completed_at_utc, error
    FROM runs
    WHERE run_type = 'pipeline'
    ORDER BY started_at_utc DESC
    LIMIT 1
  `,
    )
    .get() as
    | {
        completed_at_utc: string | null;
        error: string | null;
        id: number;
        started_at_utc: string;
        status: string;
      }
    | undefined;
  const counts = getCounts();
  const activeOpportunities = (
    db
      .prepare(
        "SELECT COUNT(*) as n FROM opportunities WHERE status = 'active'",
      )
      .get() as any
  ).n;
  const archivedOpportunities = (
    db
      .prepare(
        "SELECT COUNT(*) as n FROM opportunities WHERE status = 'archived'",
      )
      .get() as any
  ).n;

  const rawStageEvents = latestRun
    ? (db
        .prepare(
          `
      SELECT stage, status, summary, payload_json, created_at_utc
      FROM run_events
      WHERE run_id = ?
        AND event_type IN ('pipeline.stage_completed', 'pipeline.stage_failed')
      ORDER BY created_at_utc ASC
    `,
        )
        .all(latestRun.id) as Array<{
        created_at_utc: string;
        payload_json: string;
        stage: string | null;
        status: string;
        summary: string;
      }>)
    : [];

  const rawRecentWarnings = db
    .prepare(
      `
    SELECT run_id, stage, status, summary, payload_json, created_at_utc
    FROM run_events
    WHERE status IN ('warning', 'error')
    ORDER BY created_at_utc DESC
    LIMIT 5
  `,
    )
    .all() as Array<{
    created_at_utc: string;
    payload_json: string;
    run_id: number | null;
    stage: string | null;
    status: string;
    summary: string;
  }>;

  return {
    active_opportunities: activeOpportunities,
    archived_opportunities: archivedOpportunities,
    counts,
    latest_run: latestRun ?? null,
    recent_warnings: rawRecentWarnings.map((warning) => {
      const payload = parseJson(warning.payload_json);
      return {
        created_at_utc: warning.created_at_utc,
        failure_class: payload.failure_class ?? null,
        payload,
        run_id: warning.run_id,
        stage: warning.stage,
        status: warning.status,
        summary: warning.summary,
      };
    }),
    stages: rawStageEvents.map((event) => {
      const payload = parseJson(event.payload_json);
      return {
        created_at_utc: event.created_at_utc,
        duration_ms:
          typeof payload.duration_ms === 'number' ? payload.duration_ms : null,
        payload,
        stage: event.stage,
        status: event.status,
        summary: event.summary,
      };
    }),
  };
}

export function buildPipelineStatusReport(db: Database.Database): string {
  const snapshot = buildPipelineStatusSnapshot(db);
  const latestRun = snapshot.latest_run;
  const lines = [
    latestRun
      ? `Latest pipeline run: #${latestRun.id} [${latestRun.status}] ${latestRun.started_at_utc}`
      : 'Latest pipeline run: none recorded',
    latestRun?.completed_at_utc
      ? `Completed: ${latestRun.completed_at_utc}`
      : 'Completed: still running or unavailable',
    latestRun?.error ? `Error: ${latestRun.error}` : 'Error: none',
    '',
    `Counts: ${snapshot.counts.source_items} sources, ${snapshot.counts.insights} insights, ${snapshot.counts.opportunities} opportunities, ${snapshot.active_opportunities} active, ${snapshot.archived_opportunities} archived, ${snapshot.counts.runs_pending} open research runs, ${snapshot.counts.artifacts} artifacts, ${snapshot.counts.exploration_artifacts} explorations`,
    '',
    'Stages:',
  ];

  if (!snapshot.stages.length) {
    lines.push('- No stage events recorded.');
  } else {
    for (const event of snapshot.stages) {
      const duration = event.duration_ms ? ` (${event.duration_ms}ms)` : '';
      lines.push(
        `- ${event.stage ?? 'unknown'}: ${event.status}${duration} — ${event.summary}`,
      );
    }
  }

  lines.push('', 'Recent warnings:');
  if (!snapshot.recent_warnings.length) {
    lines.push('- No recent warnings or errors.');
  } else {
    for (const warning of snapshot.recent_warnings) {
      const failureClass = warning.failure_class
        ? ` [${warning.failure_class}]`
        : '';
      lines.push(
        `- run #${warning.run_id ?? 'n/a'} ${warning.stage ?? 'unknown'} ${warning.status}${failureClass}: ${warning.summary}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function buildLatestSnapshot(
  db: Database.Database,
  limit = 10,
): LatestSnapshot {
  const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  return {
    artifacts: db
      .prepare(
        `
      SELECT
        a.id,
        a.path,
        a.run_id,
        a.created_at_utc,
        o.slug AS opportunity_slug,
        o.title AS opportunity_title
      FROM artifacts a
      LEFT JOIN opportunities o ON o.id = a.opportunity_id
      ORDER BY a.created_at_utc DESC, a.id DESC
      LIMIT ?
    `,
      )
      .all(boundedLimit) as LatestSnapshot['artifacts'],
    opportunities: db
      .prepare(
        `
      SELECT slug, title, status, lifecycle_stage, final_score, updated_at_utc
      FROM opportunities
      ORDER BY final_score DESC, updated_at_utc DESC, id DESC
      LIMIT ?
    `,
      )
      .all(boundedLimit) as LatestSnapshot['opportunities'],
    runs: db
      .prepare(
        `
      SELECT id, run_type, target_type, target_id, status, started_at_utc, completed_at_utc
      FROM runs
      ORDER BY started_at_utc DESC, id DESC
      LIMIT ?
    `,
      )
      .all(boundedLimit) as LatestSnapshot['runs'],
  };
}

export function buildLatestReport(db: Database.Database, limit = 10): string {
  const snapshot = buildLatestSnapshot(db, limit);
  const lines = ['Latest runs:'];

  if (!snapshot.runs.length) {
    lines.push('- No runs recorded.');
  } else {
    for (const run of snapshot.runs) {
      lines.push(
        `- #${run.id} ${run.run_type}/${run.target_type}:${run.target_id ?? 'n/a'} [${run.status}] ${run.started_at_utc}`,
      );
    }
  }

  lines.push('', 'Latest opportunities:');
  if (!snapshot.opportunities.length) {
    lines.push('- No opportunities recorded.');
  } else {
    for (const opportunity of snapshot.opportunities) {
      lines.push(
        `- ${opportunity.slug} (${opportunity.final_score}) ${formatLifecycleStage(opportunity.lifecycle_stage)} [${opportunity.status}] — ${opportunity.title}`,
      );
    }
  }

  lines.push('', 'Latest artifacts:');
  if (!snapshot.artifacts.length) {
    lines.push('- No artifacts generated.');
  } else {
    for (const artifact of snapshot.artifacts) {
      lines.push(
        `- ${artifact.created_at_utc}: ${artifact.opportunity_slug ?? 'unknown'} — ${artifact.path}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function buildArtifactsSnapshot(
  db: Database.Database,
  limit = 20,
): ArtifactsSnapshot {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return {
    artifacts: db
      .prepare(
        `
      SELECT
        a.id,
        a.path,
        a.run_id,
        a.approved_at_utc,
        a.created_at_utc,
        o.slug AS opportunity_slug,
        o.title AS opportunity_title,
        ae.relative_path,
        ae.status AS export_status,
        ae.attempt_count AS export_attempt_count,
        ae.commit_sha AS export_commit_sha,
        ae.last_error AS export_last_error
      FROM artifacts a
      JOIN opportunities o ON o.id = a.opportunity_id
      LEFT JOIN artifact_exports ae ON ae.artifact_id = a.id
      ORDER BY COALESCE(a.approved_at_utc, a.created_at_utc) DESC, a.id DESC
      LIMIT ?
    `,
      )
      .all(boundedLimit) as ArtifactsSnapshot['artifacts'],
  };
}

export function buildArtifactsReport(
  db: Database.Database,
  limit = 20,
): string {
  const snapshot = buildArtifactsSnapshot(db, limit);
  const lines = ['Artifacts:'];

  if (!snapshot.artifacts.length) {
    lines.push('- No artifacts generated.');
    return `${lines.join('\n')}\n`;
  }

  for (const artifact of snapshot.artifacts) {
    const exportStatus = artifact.export_status
      ? ` export=${artifact.export_status}`
      : ' export=not_queued';
    const commit = artifact.export_commit_sha
      ? ` commit=${artifact.export_commit_sha}`
      : '';
    lines.push(
      `- ${artifact.created_at_utc}: ${artifact.opportunity_slug} run #${artifact.run_id}${exportStatus}${commit} — ${artifact.path}`,
    );
    if (artifact.export_last_error) {
      lines.push(`  Last export error: ${artifact.export_last_error}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function buildOpportunityExplanationSnapshot(
  db: Database.Database,
  slug: string,
): OpportunityExplanationSnapshot {
  const opportunity = db
    .prepare(
      `
    SELECT *
    FROM opportunities
    WHERE slug = ?
  `,
    )
    .get(slug) as
    | {
        cluster_key: string;
        final_score: number;
        id: number;
        lifecycle_stage: string;
        market_score: number;
        metadata_json: string;
        score: number;
        slug: string;
        status: string;
        taste_adjustment: number;
        thesis: string;
        title: string;
      }
    | undefined;
  if (!opportunity) {
    throw new Error(`Opportunity '${slug}' not found.`);
  }

  const metadata = parseJson(opportunity.metadata_json);
  const taste = computeTasteForOpportunity(
    db,
    opportunity.id,
    Number(opportunity.market_score) || Number(opportunity.score) || 0,
  );
  const features = extractOpportunityFeatures(db, opportunity.id);
  const sourceSummary = db
    .prepare(
      `
    SELECT source, COUNT(*) as n
    FROM source_items si
    JOIN opportunity_sources os ON os.source_item_id = si.id
    WHERE os.opportunity_id = ?
    GROUP BY source
    ORDER BY n DESC, source ASC
  `,
    )
    .all(opportunity.id) as Array<{ n: number; source: string }>;
  const artifactHistory = db
    .prepare(
      `
    SELECT path, created_at_utc
    FROM artifacts
    WHERE opportunity_id = ?
    ORDER BY created_at_utc DESC
  `,
    )
    .all(opportunity.id) as Array<{ created_at_utc: string; path: string }>;

  return {
    artifact_history: artifactHistory,
    cluster_key: opportunity.cluster_key,
    evidence: {
      insight_count: metadata.insight_count ?? 0,
      source_count: metadata.source_count ?? 0,
      source_summary: sourceSummary.map((row) => ({
        count: row.n,
        source: row.source,
      })),
      top_harvest_signals: metadata.top_harvest_signals ?? [],
      top_source_patterns: metadata.top_source_patterns ?? [],
    },
    feature_snapshot: features,
    lifecycle: formatLifecycleStage(opportunity.lifecycle_stage),
    opportunity: {
      id: opportunity.id,
      slug: opportunity.slug,
      status: opportunity.status,
      thesis: opportunity.thesis,
      title: opportunity.title,
    },
    scores: {
      final: opportunity.final_score,
      market: opportunity.market_score,
      taste: opportunity.taste_adjustment,
    },
    taste_match: {
      founder_preference_adjustment: taste.preferenceAdjustment,
      founder_preference_signals: taste.preferenceSignals,
      learned_adjustment: taste.learnedAdjustment,
      matched_features: taste.matchedFeatures,
      type_scores: taste.typeScores,
    },
  };
}

export function buildOpportunityExplanation(
  db: Database.Database,
  slug: string,
): string {
  const snapshot = buildOpportunityExplanationSnapshot(db, slug);
  const lines = [
    `${snapshot.opportunity.title} (${snapshot.opportunity.slug})`,
    `Lifecycle: ${snapshot.lifecycle} | Status: ${snapshot.opportunity.status}`,
    `Scores: market=${snapshot.scores.market} taste=${snapshot.scores.taste} final=${snapshot.scores.final}`,
    `Cluster: ${snapshot.cluster_key}`,
    `Thesis: ${snapshot.opportunity.thesis}`,
    '',
    'Evidence:',
    `- Insights: ${snapshot.evidence.insight_count}`,
    `- Sources: ${snapshot.evidence.source_count} (${snapshot.evidence.source_summary.map((row) => `${row.source}:${row.count}`).join(', ') || 'none'})`,
    `- Top source patterns: ${snapshot.evidence.top_source_patterns.join(', ') || 'none'}`,
    `- Top harvest signals: ${snapshot.evidence.top_harvest_signals.join(', ') || 'none'}`,
    '',
    'Taste match:',
    `- Type scores: cluster=${snapshot.taste_match.type_scores.cluster_key}, source_pattern=${snapshot.taste_match.type_scores.source_pattern}, harvest_signal=${snapshot.taste_match.type_scores.harvest_signal}, insight_type=${snapshot.taste_match.type_scores.insight_type}, source_origin=${snapshot.taste_match.type_scores.source_origin}`,
    `- Learned adjustment: ${snapshot.taste_match.learned_adjustment}`,
    `- Founder preference adjustment: ${snapshot.taste_match.founder_preference_adjustment}`,
    `- Founder preference signals: ${snapshot.taste_match.founder_preference_signals.map((signal) => `${signal.signal}=${signal.score}`).join(', ') || 'none'}`,
    `- Matched features: ${snapshot.taste_match.matched_features.map((feature) => `${feature.featureType}:${feature.featureValue}=${feature.learnedWeight}`).join(', ') || 'none'}`,
    '',
    'Feature snapshot:',
    `- cluster_key: ${snapshot.feature_snapshot.cluster_key.join(', ') || 'none'}`,
    `- source_pattern: ${snapshot.feature_snapshot.source_pattern.join(', ') || 'none'}`,
    `- harvest_signal: ${snapshot.feature_snapshot.harvest_signal.join(', ') || 'none'}`,
    `- insight_type: ${snapshot.feature_snapshot.insight_type.join(', ') || 'none'}`,
    `- source_origin: ${snapshot.feature_snapshot.source_origin.join(', ') || 'none'}`,
    '',
    'Artifact history:',
  ];

  if (!snapshot.artifact_history.length) {
    lines.push('- No artifacts generated.');
  } else {
    for (const artifact of snapshot.artifact_history) {
      lines.push(`- ${artifact.created_at_utc}: ${artifact.path}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
