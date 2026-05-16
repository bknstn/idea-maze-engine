import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';

import {
  artifactSourceRelativePath,
  queueGitHubArtifactExport,
  resolveArtifactPath,
  type GitHubExportState,
} from './artifact-export.ts';
import { setOpportunityLifecycle } from './opportunity-state.ts';
import { recordRunEvent } from './run-events.ts';
import {
  recomputeAllOpportunityScores,
  updateTasteProfileFromPublicationSignal,
} from './taste.ts';

const ARTIFACTS_REPO_URL =
  process.env.IDEA_MAZE_ARTIFACTS_REPO_URL?.trim() || null;
const ARTIFACTS_REPO_BRANCH =
  process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH?.trim() || 'main';

export interface ResearchDraft {
  opportunity_slug: string;
  thesis: string;
  evidence_from_inbox: string[];
  evidence_from_telegram: string[];
  evidence_from_reddit: string[];
  external_market_check: string[];
  product_concept: string;
  mvp_scope: string[];
  implementation_plan: string[];
  distribution_plan: string[];
  risks: string[];
  source_refs: number[];
}

const QUALITY_NOISE_TOKENS = new Set([
  'amp',
  'code',
  'com',
  'comments',
  'href',
  'html',
  'http',
  'https',
  'pre',
  'quot',
  'reddit',
  'span',
  'strong',
  'style',
]);

function normalizeQualityText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function qualityIssues(run: any, draft: ResearchDraft): string[] {
  const issues: string[] = [];
  let metadata: any = {};
  try {
    metadata = JSON.parse(run.metadata_json);
  } catch {
    issues.push('invalid_run_metadata');
  }

  const promptMetadata = metadata.prompt_metadata ?? {};
  if (promptMetadata.validation_status !== 'valid') {
    issues.push(`prompt_validation_${promptMetadata.validation_status ?? 'missing'}`);
  }
  if (!promptMetadata.model) {
    issues.push('missing_model');
  }

  const slugTokens = draft.opportunity_slug.split(/[^a-z0-9]+/i).filter(Boolean);
  if (
    slugTokens.length > 0 &&
    slugTokens.every((token) => QUALITY_NOISE_TOKENS.has(token.toLowerCase()))
  ) {
    issues.push('noise_slug');
  }

  const evidence = [
    ...draft.evidence_from_inbox,
    ...draft.evidence_from_telegram,
    ...draft.evidence_from_reddit,
    ...draft.external_market_check,
  ];
  if (!draft.source_refs.length) {
    issues.push('missing_source_refs');
  }
  if (!evidence.some((item) => normalizeQualityText(item) !== 'none')) {
    issues.push('missing_evidence');
  }

  const renderedDraft = normalizeQualityText(
    [
      draft.thesis,
      draft.product_concept,
      ...draft.mvp_scope,
      ...draft.implementation_plan,
      ...draft.distribution_plan,
      ...draft.risks,
      ...evidence,
    ].join(' '),
  );
  if (renderedDraft.includes('insufficient signal')) {
    issues.push('insufficient_signal');
  }

  return issues;
}

function assertPublishableDraft(run: any, draft: ResearchDraft): void {
  const issues = qualityIssues(run, draft);
  if (issues.length) {
    throw new Error(
      `Run #${run.id} failed research quality gate: ${issues.join(', ')}`,
    );
  }
}

function getRun(db: Database.Database, runId: number): any {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as any;
  if (!run) {
    throw new Error(`Run #${runId} not found.`);
  }
  return run;
}

function getDraft(run: any, runId: number): ResearchDraft {
  const meta = JSON.parse(run.metadata_json);
  const draft: ResearchDraft | undefined = meta.draft;
  if (!draft) {
    throw new Error(`Run #${runId} has no draft in metadata.`);
  }
  return draft;
}

function renderSections(draft: ResearchDraft): string[] {
  const fmtList = (items: string[]) =>
    items.length ? items.map((s) => `- ${s}`).join('\n') : '- None';

  const sections: [string, string][] = [
    ['Thesis', draft.thesis],
    ['Evidence from Inbox', fmtList(draft.evidence_from_inbox)],
    ['Evidence from Telegram', fmtList(draft.evidence_from_telegram)],
    ['Evidence from Reddit', fmtList(draft.evidence_from_reddit)],
    ['External Market Check', fmtList(draft.external_market_check)],
    ['Product Concept', draft.product_concept],
    ['MVP Scope', fmtList(draft.mvp_scope)],
    ['Implementation Plan', fmtList(draft.implementation_plan)],
    ['Distribution Plan', fmtList(draft.distribution_plan)],
    ['Risks / Unknowns', fmtList(draft.risks)],
  ];

  const lines: string[] = [];
  for (const [title, body] of sections) {
    lines.push(`## ${title}`, '', body, '');
  }
  return lines;
}

export function renderMarkdown(
  draft: ResearchDraft,
  runId: number,
  createdAtUtc = new Date().toISOString(),
): string {
  const lines = [
    '---',
    `run_id: ${runId}`,
    `opportunity_slug: ${draft.opportunity_slug}`,
    `created_at_utc: ${createdAtUtc}`,
    `source_refs: [${draft.source_refs.join(', ')}]`,
    '---',
    '',
    ...renderSections(draft),
  ];

  return lines.join('\n').trim() + '\n';
}

export function artifactPath(slug: string, timestamp = new Date()): string {
  return resolveArtifactPath(artifactSourceRelativePath(slug, timestamp));
}

export function publishResearchArtifact(
  db: Database.Database,
  runId: number,
  notes: string | null = null,
): {
  githubExport: GitHubExportState;
  path: string;
  opportunityId: number;
  draft: ResearchDraft;
} {
  const run = getRun(db, runId);
  if (!['draft_ready', 'review_gate'].includes(run.status)) {
    throw new Error(
      `Run #${runId} has no publishable draft (status: ${run.status}).`,
    );
  }

  const draft = getDraft(run, runId);
  assertPublishableDraft(run, draft);
  const opportunityId = Number(run.target_id);
  if (
    !db.prepare('SELECT 1 FROM opportunities WHERE id = ?').get(opportunityId)
  ) {
    throw new Error(`Opportunity #${opportunityId} not found.`);
  }

  const publishedAt = new Date();
  const now = publishedAt.toISOString();
  const relativePath = artifactSourceRelativePath(
    draft.opportunity_slug,
    publishedAt,
  );
  const path = resolveArtifactPath(relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderMarkdown(draft, runId, now), 'utf-8');

  db.prepare(
    "INSERT INTO approvals (run_id, decision, notes, decided_at_utc) VALUES (?, 'published', ?, ?)",
  ).run(runId, notes, now);
  const artifactInsert = db
    .prepare(
      'INSERT INTO artifacts (opportunity_id, run_id, path, version, approved_at_utc, created_at_utc) VALUES (?, ?, ?, 1, ?, ?)',
    )
    .run(opportunityId, runId, path, now, now);
  const artifactId = Number(artifactInsert.lastInsertRowid);
  const githubExport = queueGitHubArtifactExport(db, {
    artifactId,
    opportunityId,
    relativePath,
    repoBranch: ARTIFACTS_REPO_BRANCH,
    repoUrl: ARTIFACTS_REPO_URL,
    runId,
  });

  db.prepare(
    "UPDATE runs SET status = 'published', completed_at_utc = ? WHERE id = ?",
  ).run(now, runId);
  db.prepare(
    'UPDATE opportunities SET last_reviewed_at_utc = ? WHERE id = ?',
  ).run(now, opportunityId);
  setOpportunityLifecycle(db, opportunityId, 'artifact', {
    payload: {
      publication_notes: notes,
    },
    runId,
    summary: `Research artifact published for run #${runId}.`,
  });
  updateTasteProfileFromPublicationSignal(db, {
    opportunityId,
    runId,
    signal: 'published',
  });
  recomputeAllOpportunityScores(db);
  recordRunEvent(db, {
    eventType: 'artifact.published',
    opportunityId,
    payload: {
      artifact_id: artifactId,
      artifact_path: path,
      artifact_relative_path: relativePath,
      github_export_repo_branch: ARTIFACTS_REPO_BRANCH,
      github_export_repo_url: ARTIFACTS_REPO_URL,
      github_export_status: githubExport.status,
      notes,
    },
    runId,
    stage: 'artifact',
    status: 'ok',
    summary: `Research artifact published for run #${runId}.`,
  });

  return { githubExport, path, opportunityId, draft };
}
