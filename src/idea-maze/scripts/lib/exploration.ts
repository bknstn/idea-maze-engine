import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';

import { closeDb, getDb } from './db.ts';
import {
  generateExplorationJson,
  getExplorationModel,
  getMissingLlmReason,
  isLlmConfigured,
} from './llm.ts';
import { DATA_DIR } from './paths.ts';
import {
  EXPLORATION_PROMPT_NAME,
  EXPLORATION_PROMPT_VERSION,
  EXPLORATION_SYSTEM_PROMPT,
  buildExplorationUserPrompt,
} from './prompts.ts';
import { classifyFailure, createRun, recordRunEvent, updateRunStatus } from './run-events.ts';
import { initSchema } from './schema.ts';
import {
  type ValidatedExplorationBrief,
  validateExplorationBrief,
} from './validation.ts';

interface Logger {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
}

interface OpportunityRow {
  id: number;
  slug: string;
  title: string;
  thesis: string;
  status: string;
  lifecycle_stage: string;
  metadata_json: string;
}

export interface ExploreOpportunityOptions {
  db?: Database.Database;
  force?: boolean;
  logger?: Logger;
  requestedBy?: string;
}

export interface PreparedExplorationResult {
  context: { directEvidence: string[]; contextualResearch: string[] };
  opportunityId: number;
  opportunitySlug: string;
  outputSchema: string;
  prompt: string;
  runId: number;
  status: 'awaiting_external_brief';
}

export interface ExploreOpportunityResult {
  briefPath?: string;
  explorationArtifactId?: number;
  opportunityId: number;
  opportunitySlug: string;
  runId: number;
  status: 'completed' | 'needs_manual_exploration';
  validationErrors?: string[];
}

export interface FinalizeExplorationOptions {
  brief: unknown;
  db?: Database.Database;
  logger?: Logger;
  providerMetadata?: Record<string, unknown>;
  requestedBy?: string;
}

export type FinalizeExplorationResult = ExploreOpportunityResult;

export function explorationRelativePath(slug: string, timestamp = new Date()): string {
  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const d = String(timestamp.getUTCDate()).padStart(2, '0');
  return `data/explorations/${y}/${m}/${d}/${slug}.md`;
}

export function resolveExplorationPath(relativePath: string): string {
  return resolve(DATA_DIR, '..', relativePath.replace(/^data\//, 'data/'));
}

function list(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : '- None';
}

export function renderExplorationMarkdown(
  brief: ValidatedExplorationBrief,
  meta: { createdAtUtc: string; opportunitySlug: string; runId: number },
): string {
  return `---\nrun_id: ${meta.runId}\nopportunity_slug: ${meta.opportunitySlug}\ncreated_at_utc: ${meta.createdAtUtc}\n---\n\n# Exploration Brief: ${meta.opportunitySlug}\n\n## Thesis\n${brief.thesis}\n\n## ICP\n- Buyer: ${brief.icp.buyer}\n- User: ${brief.icp.user}\n- Trigger: ${brief.icp.trigger}\n- Current workaround: ${brief.icp.current_workaround}\n- Budget owner: ${brief.icp.budget_owner}\n\n## Direct Evidence Summary\n${list(brief.evidence_summary.map((e) => `${e.source_type} (${e.evidence_role}): ${e.quote_or_summary} — ${e.interpretation}`))}\n\n## Competitor Map\n${list(brief.competitor_map.map((c) => `${c.name} (${c.category}): ${c.positioning}; weakness: ${c.weakness}`))}\n\n## Workflow / Wedge\n- Narrow workflow: ${brief.workflow_wedge.narrow_workflow}\n- Must-have features:\n${list(brief.workflow_wedge.must_have_features)}\n- Explicit non-goals:\n${list(brief.workflow_wedge.explicit_non_goals)}\n\n## Interview Script\n${list(brief.interview_script)}\n\n## Smoke Test\n- Audience: ${brief.smoke_test.audience}\n- Offer: ${brief.smoke_test.offer}\n- Channel: ${brief.smoke_test.channel}\n- Success metric: ${brief.smoke_test.success_metric}\n\n## Pricing Hypothesis\n${brief.pricing_hypothesis}\n\n## Kill Criteria\n${list(brief.kill_criteria)}\n\n## Open Questions\n${list(brief.open_questions)}\n\n## Next Action\n${brief.next_action}\n`;
}

export function writeExplorationMarkdown(relativePath: string, markdown: string): string {
  const absolutePath = resolveExplorationPath(relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, markdown, 'utf-8');
  return absolutePath;
}

function parseJsonObject(value: string | null | undefined): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function outputSchema(): string {
  return 'ValidatedExplorationBrief JSON: thesis, icp{buyer,user,trigger,current_workaround,budget_owner}, evidence_summary[], competitor_map[], workflow_wedge{narrow_workflow,must_have_features[],explicit_non_goals[]}, interview_script[], smoke_test{audience,offer,channel,success_metric}, pricing_hypothesis, kill_criteria[], open_questions[], next_action.';
}

function loadOpportunity(db: Database.Database, target: string): OpportunityRow {
  const bySlug = db.prepare('SELECT * FROM opportunities WHERE slug = ?').get(target) as OpportunityRow | undefined;
  const byId = bySlug ?? (Number.isFinite(Number(target))
    ? db.prepare('SELECT * FROM opportunities WHERE id = ?').get(Number(target)) as OpportunityRow | undefined
    : undefined);
  if (!byId) throw new Error(`Opportunity '${target}' not found.`);
  return byId;
}

function assertApprovedActive(opp: OpportunityRow, force: boolean | undefined): void {
  if (force) return;
  if (opp.lifecycle_stage !== 'approved' || opp.status !== 'active') {
    throw new Error(`Exploration requires approved active opportunity; got lifecycle_stage='${opp.lifecycle_stage}' status='${opp.status}'. Use --force to override.`);
  }
}

function latestApprovedDraft(db: Database.Database, opportunityId: number): string {
  const row = db.prepare(`
    SELECT metadata_json
    FROM runs
    WHERE target_type = 'opportunity'
      AND target_id = ?
      AND status IN ('approved', 'published', 'review_gate')
    ORDER BY COALESCE(completed_at_utc, started_at_utc) DESC, id DESC
    LIMIT 1
  `).get(String(opportunityId)) as { metadata_json: string } | undefined;
  const metadata = parseJsonObject(row?.metadata_json);
  const draft = metadata.draft;
  if (!draft) return '';
  return typeof draft === 'string' ? draft : JSON.stringify(draft, null, 2);
}

function truncate(value: string, limit = 500): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function loadEvidence(db: Database.Database, opportunityId: number): { directEvidence: string[]; contextualResearch: string[] } {
  const rows = db.prepare(`
    SELECT si.*
    FROM source_items si
    JOIN opportunity_sources os ON os.source_item_id = si.id
    WHERE os.opportunity_id = ?
    ORDER BY json_extract(si.metadata_json, '$.harvest_score') DESC, si.timestamp_utc DESC
    LIMIT 30
  `).all(opportunityId) as Array<{ id: number; source: string; channel_or_label: string | null; title: string | null; text: string }>;
  const directEvidence: string[] = [];
  const contextualResearch: string[] = [];
  for (const row of rows) {
    const formatted = `${row.source}:${row.id}${row.title ? ` ${row.title}` : ''} — ${truncate(row.text)}`;
    if (row.source === 'search' || row.channel_or_label === 'tavily') contextualResearch.push(formatted);
    else directEvidence.push(formatted);
  }
  return { directEvidence, contextualResearch };
}

function preparePacket(db: Database.Database, opp: OpportunityRow): Omit<PreparedExplorationResult, 'runId' | 'status'> {
  const evidence = loadEvidence(db, opp.id);
  const prompt = buildExplorationUserPrompt({
    slug: opp.slug,
    title: opp.title,
    thesis: opp.thesis,
    approved_research_draft: latestApprovedDraft(db, opp.id),
    source_evidence: evidence.directEvidence,
    contextual_research: evidence.contextualResearch,
    search_synthesis: [],
  });
  return {
    context: evidence,
    opportunityId: opp.id,
    opportunitySlug: opp.slug,
    outputSchema: outputSchema(),
    prompt,
  };
}

function promptMetadata(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: getExplorationModel(),
    prompt_name: EXPLORATION_PROMPT_NAME,
    prompt_version: EXPLORATION_PROMPT_VERSION,
    ...extra,
  };
}

function persistBrief(
  db: Database.Database,
  opp: OpportunityRow,
  runId: number,
  brief: ValidatedExplorationBrief,
): { briefPath: string; explorationArtifactId: number; metadata: Record<string, unknown> } {
  const createdAtUtc = new Date().toISOString();
  const relativePath = explorationRelativePath(opp.slug, new Date(createdAtUtc));
  const markdown = renderExplorationMarkdown(brief, { createdAtUtc, opportunitySlug: opp.slug, runId });
  const briefPath = writeExplorationMarkdown(relativePath, markdown);
  const result = db.prepare(`
    INSERT INTO exploration_artifacts (opportunity_id, run_id, path, brief_json, created_at_utc)
    VALUES (?, ?, ?, ?, ?)
  `).run(opp.id, runId, briefPath, JSON.stringify(brief), createdAtUtc);
  const metadata = parseJsonObject(opp.metadata_json);
  db.prepare(`
    UPDATE opportunities
    SET metadata_json = ?, updated_at_utc = ?
    WHERE id = ?
  `).run(JSON.stringify({ ...metadata, last_explored_at_utc: createdAtUtc }), createdAtUtc, opp.id);
  return { briefPath, explorationArtifactId: Number(result.lastInsertRowid), metadata: { created_at_utc: createdAtUtc, relative_path: relativePath } };
}

export async function prepareExploration(
  target: string,
  options: ExploreOpportunityOptions = {},
): Promise<PreparedExplorationResult> {
  const ownsDb = !options.db;
  const db = options.db ?? getDb();
  const requestedBy = options.requestedBy ?? 'user';
  try {
    initSchema(db);
    const opp = loadOpportunity(db, target);
    assertApprovedActive(opp, options.force);
    const packet = preparePacket(db, opp);
    const runId = createRun(db, {
      metadata: { packet, prompt_metadata: promptMetadata({ validation_status: 'awaiting_external_brief' }) },
      requestedBy,
      runType: 'explore',
      status: 'awaiting_external_brief',
      targetId: String(opp.id),
      targetType: 'opportunity',
    });
    recordRunEvent(db, {
      actor: requestedBy,
      eventType: 'explore.prepare_only',
      opportunityId: opp.id,
      payload: promptMetadata({ mode: 'prepare_only' }),
      runId,
      stage: 'explore',
      status: 'info',
      summary: `Prepared exploration handoff for ${opp.slug}.`,
    });
    return { ...packet, runId, status: 'awaiting_external_brief' };
  } finally {
    if (ownsDb) closeDb();
  }
}

function needsManual(
  db: Database.Database,
  opp: OpportunityRow,
  runId: number,
  requestedBy: string,
  validationErrors: string[],
  providerMetadata: Record<string, unknown>,
): ExploreOpportunityResult {
  const metadata = {
    prompt_metadata: promptMetadata({
      provider_metadata: providerMetadata,
      validation_errors: validationErrors,
      validation_status: 'invalid_external_brief',
    }),
  };
  updateRunStatus(db, runId, 'needs_manual_exploration', { metadata });
  recordRunEvent(db, {
    actor: requestedBy,
    eventType: 'explore.needs_manual_exploration',
    opportunityId: opp.id,
    payload: metadata.prompt_metadata,
    runId,
    stage: 'explore',
    status: 'warning',
    summary: `Exploration needs manual brief for ${opp.slug}.`,
  });
  return { opportunityId: opp.id, opportunitySlug: opp.slug, runId, status: 'needs_manual_exploration', validationErrors };
}

export async function exploreOpportunity(
  target: string,
  options: ExploreOpportunityOptions = {},
): Promise<ExploreOpportunityResult> {
  const ownsDb = !options.db;
  const db = options.db ?? getDb();
  const requestedBy = options.requestedBy ?? 'user';
  try {
    initSchema(db);
    const opp = loadOpportunity(db, target);
    assertApprovedActive(opp, options.force);
    const packet = preparePacket(db, opp);
    const runId = createRun(db, {
      metadata: { packet, prompt_metadata: promptMetadata({ validation_status: 'pending' }) },
      requestedBy,
      runType: 'explore',
      targetId: String(opp.id),
      targetType: 'opportunity',
    });
    recordRunEvent(db, {
      actor: requestedBy,
      eventType: 'explore.started',
      opportunityId: opp.id,
      payload: promptMetadata({ mode: 'engine' }),
      runId,
      stage: 'explore',
      status: 'info',
      summary: `Exploration started for ${opp.slug}.`,
    });
    if (!isLlmConfigured()) {
      return needsManual(db, opp, runId, requestedBy, [getMissingLlmReason()], { mode: 'engine' });
    }
    let rawBrief: unknown;
    try {
      rawBrief = await generateExplorationJson<unknown>(EXPLORATION_SYSTEM_PROMPT, packet.prompt);
    } catch (err) {
      return needsManual(db, opp, runId, requestedBy, [err instanceof Error ? err.message : String(err)], { mode: 'engine', failure_class: classifyFailure(err) });
    }
    const validated = validateExplorationBrief(rawBrief);
    if (!validated.value) {
      return needsManual(db, opp, runId, requestedBy, validated.errors, { mode: 'engine' });
    }
    const persisted = persistBrief(db, opp, runId, validated.value);
    const metadata = {
      brief: validated.value,
      prompt_metadata: promptMetadata({ validation_errors: [], validation_status: 'valid' }),
      exploration_trace: { ...persisted.metadata, source_item_count: packet.context.directEvidence.length },
    };
    updateRunStatus(db, runId, 'completed', { metadata });
    recordRunEvent(db, {
      actor: requestedBy,
      eventType: 'explore.completed',
      opportunityId: opp.id,
      payload: metadata.prompt_metadata,
      runId,
      stage: 'explore',
      status: 'ok',
      summary: `Exploration completed for ${opp.slug}.`,
    });
    return { opportunityId: opp.id, opportunitySlug: opp.slug, runId, status: 'completed', briefPath: persisted.briefPath, explorationArtifactId: persisted.explorationArtifactId };
  } finally {
    if (ownsDb) closeDb();
  }
}

export async function finalizeExploration(
  runId: number,
  options: FinalizeExplorationOptions,
): Promise<FinalizeExplorationResult> {
  const ownsDb = !options.db;
  const db = options.db ?? getDb();
  const requestedBy = options.requestedBy ?? 'hermes';
  try {
    initSchema(db);
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as { id: number; target_id: string | null; metadata_json: string } | undefined;
    if (!run?.target_id) throw new Error(`Explore run #${runId} not found or missing target.`);
    const opp = loadOpportunity(db, run.target_id);
    const providerMetadata = options.providerMetadata ?? {};
    const validated = validateExplorationBrief(options.brief);
    if (!validated.value) {
      return needsManual(db, opp, runId, requestedBy, validated.errors, providerMetadata);
    }
    const persisted = persistBrief(db, opp, runId, validated.value);
    const metadata = {
      ...parseJsonObject(run.metadata_json),
      brief: validated.value,
      prompt_metadata: promptMetadata({ provider_metadata: providerMetadata, validation_errors: [], validation_status: 'valid_external_brief' }),
      exploration_trace: persisted.metadata,
    };
    updateRunStatus(db, runId, 'completed', { metadata });
    recordRunEvent(db, {
      actor: requestedBy,
      eventType: 'explore.completed',
      opportunityId: opp.id,
      payload: metadata.prompt_metadata,
      runId,
      stage: 'explore',
      status: 'ok',
      summary: `External exploration finalized for ${opp.slug}.`,
    });
    return { opportunityId: opp.id, opportunitySlug: opp.slug, runId, status: 'completed', briefPath: persisted.briefPath, explorationArtifactId: persisted.explorationArtifactId };
  } finally {
    if (ownsDb) closeDb();
  }
}
