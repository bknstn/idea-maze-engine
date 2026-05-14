import type Database from 'better-sqlite3';

import { closeDb, getDb } from './db.ts';
import {
  generateResearchJson,
  isLlmConfigured,
  RESEARCH_MODEL,
} from './llm.ts';
import { setOpportunityLifecycle } from './opportunity-state.ts';
import {
  RESEARCH_PROMPT_NAME,
  RESEARCH_PROMPT_VERSION,
  RESEARCH_SYSTEM_PROMPT,
  buildResearchUserPrompt,
} from './prompts.ts';
import { classifyFailure, createRun, recordRunEvent } from './run-events.ts';
import { initSchema } from './schema.ts';
import {
  enrichOpportunityWithSearch,
  isSearchConfigured,
  type SearchEvidenceItem,
} from './search.ts';
import { publishResearchArtifact, type ResearchDraft } from './review.ts';
import {
  type ValidatedResearchDraft,
  validateResearchDraft,
} from './validation.ts';

interface Logger {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
}

export interface ResearchOpportunityOptions {
  db?: Database.Database;
  logger?: Logger;
  publicationNotes?: string | null;
  requestedBy?: string;
  runIdForEvents?: number | null;
}

export interface ResearchOpportunityResult {
  artifactPath?: string;
  opportunityId: number;
  opportunitySlug: string;
  runId: number;
  status: 'published';
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'untitled'
  );
}

async function buildLlmDraft(
  opp: { slug: string; title: string; thesis: string },
  sourceItems: any[],
  searchItems: SearchEvidenceItem[],
  searchAnswers: string[],
): Promise<unknown> {
  const inbox = sourceItems
    .filter((s) => s.source === 'gmail')
    .slice(0, 5)
    .map((s: any) => `${s.id}: ${s.text.slice(0, 220)}`);
  const telegram = sourceItems
    .filter((s) => s.source === 'telegram')
    .slice(0, 5)
    .map((s: any) => `${s.id}: ${s.text.slice(0, 220)}`);
  const reddit = sourceItems
    .filter((s) => s.source === 'reddit')
    .slice(0, 5)
    .map((s: any) => `${s.id}: ${s.text.slice(0, 220)}`);
  const external = searchItems
    .slice(0, 5)
    .map((s) => s.title || s.text.slice(0, 180));

  const prompt = buildResearchUserPrompt({
    slug: opp.slug,
    title: opp.title,
    thesis: opp.thesis,
    inbox_evidence: inbox,
    telegram_evidence: telegram,
    reddit_evidence: reddit,
    external_research: external,
    search_synthesis: searchAnswers,
  });

  return generateResearchJson<unknown>(RESEARCH_SYSTEM_PROMPT, prompt);
}

function buildTemplateDraft(
  opp: { slug: string; title: string; thesis: string; cluster_key: string },
  sourceItems: any[],
  searchItems: SearchEvidenceItem[],
): Omit<ResearchDraft, 'opportunity_slug' | 'source_refs'> {
  const inbox = sourceItems
    .filter((s) => s.source === 'gmail')
    .slice(0, 5)
    .map((s: any) => s.text.slice(0, 220));
  const telegram = sourceItems
    .filter((s) => s.source === 'telegram')
    .slice(0, 5)
    .map((s: any) => s.text.slice(0, 220));
  const reddit = sourceItems
    .filter((s) => s.source === 'reddit')
    .slice(0, 5)
    .map((s: any) => s.text.slice(0, 220));
  const external = searchItems
    .slice(0, 5)
    .map((s) => s.title || s.text.slice(0, 180));

  return {
    thesis: opp.thesis,
    evidence_from_inbox: inbox.length ? inbox : ['None'],
    evidence_from_telegram: telegram.length ? telegram : ['None'],
    evidence_from_reddit: reddit.length ? reddit : ['None'],
    external_market_check: external.length ? external : ['None'],
    product_concept: `Build a narrow self-serve subscription around '${opp.cluster_key}' that one founder can operate without an enterprise sales motion.`,
    mvp_scope: [
      'Capture the narrowest workflow around the detected pain point.',
      'Provide one opinionated dashboard or automation path that works end-to-end without services-heavy setup.',
      'Instrument activation, retention, and willingness to pay from day one.',
    ],
    implementation_plan: [
      'Define one primary user persona inside a tiny team or solo-operator workflow.',
      'Build the narrowest functional slice that proves repeated usage without custom onboarding.',
      'Ship analytics, feedback capture, and a low-ticket pricing experiment early.',
    ],
    distribution_plan: [
      'Publish the thesis in the communities where the signal originated.',
      'Use the relevant Telegram, Reddit, or email-derived channel as the first self-serve distribution wedge.',
      'Track trial-to-paid conversion and inbound follow-up questions as validation.',
    ],
    risks: [
      'Signals may reflect noise rather than durable demand.',
      'The market may already have stronger incumbents.',
      'Inbox and channel evidence may over-index on your current network.',
      'The workflow may drift toward enterprise requirements that break a lean operating model.',
    ],
  };
}

function toPromptMetadata() {
  return {
    model: isLlmConfigured() ? RESEARCH_MODEL : null,
    prompt_name: RESEARCH_PROMPT_NAME,
    prompt_version: RESEARCH_PROMPT_VERSION,
    validation_errors: [] as string[],
    validation_status: isLlmConfigured() ? 'pending' : 'not_attempted',
  };
}

export async function researchOpportunity(
  target: string,
  options: ResearchOpportunityOptions = {},
): Promise<ResearchOpportunityResult> {
  if (!target) {
    throw new Error('Usage: tsx research-opportunity.ts <slug-or-topic>');
  }

  const ownsDb = !options.db;
  const db = options.db ?? getDb();
  const logger = options.logger ?? console;
  const publicationNotes = options.publicationNotes ?? null;
  const requestedBy = options.requestedBy ?? 'user';
  let runId: number | null = null;
  let opportunityIdForErrors: number | null = null;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();

  initSchema(db);

  const emitParentEvent = (
    input: Omit<Parameters<typeof recordRunEvent>[1], 'runId'>,
  ): void => {
    if (!options.runIdForEvents) return;
    recordRunEvent(db, {
      ...input,
      runId: options.runIdForEvents,
    });
  };

  const markRunFailed = (reason: string): void => {
    if (runId === null) return;
    db.prepare(
      `
      UPDATE runs
      SET status = 'error', completed_at_utc = ?, error = ?
      WHERE id = ? AND status IN ('running', 'draft_ready', 'review_gate')
    `,
    ).run(new Date().toISOString(), reason, runId);
    recordRunEvent(db, {
      actor: requestedBy,
      eventType: 'research.failed',
      opportunityId: opportunityIdForErrors,
      payload: {
        failure_class: classifyFailure(reason),
      },
      runId,
      stage: 'research',
      status: 'error',
      summary: reason,
    });
  };

  const installSignalHandler = (
    signal: NodeJS.Signals,
    exitCode: number,
  ): void => {
    const handler = () => {
      try {
        markRunFailed(`Interrupted by ${signal}`);
      } finally {
        process.exit(exitCode);
      }
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  };

  const removeSignalHandlers = (): void => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
    signalHandlers.clear();
  };

  try {
    let opp = db
      .prepare('SELECT * FROM opportunities WHERE slug = ?')
      .get(target) as any;
    if (!opp) {
      const slug = slugify(target);
      opp = db
        .prepare('SELECT * FROM opportunities WHERE slug = ?')
        .get(slug) as any;
      if (!opp) {
        const now = new Date().toISOString();
        db.prepare(
          `
          INSERT INTO opportunities (
            slug,
            title,
            thesis,
            score,
            market_score,
            taste_adjustment,
            final_score,
            status,
            lifecycle_stage,
            cluster_key,
            metadata_json,
            created_at_utc,
            updated_at_utc
          )
          VALUES (?, ?, ?, 1.0, 1.0, 0, 1.0, 'active', 'shortlisted', ?, '{"ad_hoc": true}', ?, ?)
        `,
        ).run(
          slug,
          target.trim(),
          `Investigate whether '${target}' could become a focused web product.`,
          slug,
          now,
          now,
        );
        opp = db
          .prepare('SELECT * FROM opportunities WHERE slug = ?')
          .get(slug) as any;
        logger.log(`Created ad-hoc opportunity: ${slug}`);
      }
    }

    opportunityIdForErrors = Number(opp.id);
    logger.log(`Researching: ${opp.title} (${opp.slug})`);

    runId = createRun(db, {
      metadata: {},
      requestedBy,
      runType: 'research',
      targetId: String(opp.id),
      targetType: 'opportunity',
    });
    logger.log(`Created run #${runId}`);
    recordRunEvent(db, {
      actor: requestedBy,
      eventType: 'research.started',
      opportunityId: Number(opp.id),
      payload: {
        publication_mode: 'artifact',
        requested_by: requestedBy,
      },
      runId,
      stage: 'research',
      status: 'info',
      summary: `Research started for ${opp.slug}.`,
    });
    emitParentEvent({
      actor: requestedBy,
      eventType: 'research.started',
      opportunityId: Number(opp.id),
      payload: {
        child_run_id: runId,
        slug: opp.slug,
      },
      stage: 'process-opportunities',
      status: 'info',
      summary: `Spawned research run #${runId} for ${opp.slug}.`,
    });
    installSignalHandler('SIGINT', 130);
    installSignalHandler('SIGTERM', 143);
    setOpportunityLifecycle(db, Number(opp.id), 'researching', {
      actor: requestedBy,
      runId,
      summary: `Research started for ${opp.slug}.`,
    });

    const sourceItems = db
      .prepare(
        `
      SELECT si.* FROM source_items si
      JOIN opportunity_sources os ON os.source_item_id = si.id
      WHERE os.opportunity_id = ?
      ORDER BY json_extract(si.metadata_json, '$.harvest_score') DESC, si.timestamp_utc DESC
    `,
      )
      .all(opp.id) as any[];
    logger.log(`Found ${sourceItems.length} linked source items.`);

    let searchItems: SearchEvidenceItem[] = [];
    let searchAnswers: string[] = [];
    let searchTrace: {
      provider: string;
      queries: string[];
      answers: string[];
      result_count: number;
      source_item_ids: number[];
    } | null = null;
    let promptMetadata = toPromptMetadata();

    if (isSearchConfigured()) {
      try {
        const enrichment = await enrichOpportunityWithSearch(
          { title: opp.title, cluster_key: opp.cluster_key },
          sourceItems,
          runId,
        );
        searchItems = enrichment.items;
        searchAnswers = enrichment.answers;
        searchTrace = {
          provider: enrichment.provider,
          queries: enrichment.queries,
          answers: enrichment.answers,
          result_count: enrichment.items.length,
          source_item_ids: enrichment.item_ids,
        };
        const answerNote = searchAnswers.length
          ? `, ${searchAnswers.length} synthesized answer(s)`
          : '';
        logger.log(
          `Search enrichment: ${searchItems.length} result(s) across ${enrichment.queries.length} quer${enrichment.queries.length === 1 ? 'y' : 'ies'}${answerNote}.`,
        );
      } catch (err) {
        logger.warn(
          `Search enrichment failed, continuing without external research: ${err}`,
        );
        recordRunEvent(db, {
          actor: requestedBy,
          eventType: 'fallback.used',
          opportunityId: Number(opp.id),
          payload: {
            failure_class: classifyFailure(err),
            fallback: 'research_without_search',
          },
          runId,
          stage: 'research',
          status: 'warning',
          summary:
            'Search enrichment failed; continuing without external research.',
        });
      }
    } else {
      logger.log('No TAVILY_API_KEY — skipping web enrichment.');
    }

    let draftBody: Omit<ResearchDraft, 'opportunity_slug' | 'source_refs'>;
    if (isLlmConfigured()) {
      try {
        logger.log('Building draft via LLM...');
        const rawDraft = await buildLlmDraft(
          opp,
          sourceItems,
          searchItems,
          searchAnswers,
        );
        const validated = validateResearchDraft(rawDraft);
        if (!validated.value) {
          promptMetadata = {
            ...promptMetadata,
            validation_errors: validated.errors,
            validation_status: 'fallback_template',
          };
          recordRunEvent(db, {
            actor: requestedBy,
            eventType: 'validation.warning',
            opportunityId: Number(opp.id),
            payload: promptMetadata,
            runId,
            stage: 'research',
            status: 'warning',
            summary:
              'Research draft validation failed; using template fallback.',
          });
          draftBody = buildTemplateDraft(opp, sourceItems, searchItems);
        } else {
          promptMetadata = {
            ...promptMetadata,
            validation_status: 'valid',
          };
          draftBody = validated.value as ValidatedResearchDraft;
        }
      } catch (err) {
        logger.warn(`LLM draft failed, using template: ${err}`);
        promptMetadata = {
          ...promptMetadata,
          validation_errors: [err instanceof Error ? err.message : String(err)],
          validation_status: 'fallback_template',
        };
        recordRunEvent(db, {
          actor: requestedBy,
          eventType: 'fallback.used',
          opportunityId: Number(opp.id),
          payload: {
            ...promptMetadata,
            failure_class: classifyFailure(err),
            fallback: 'template_draft',
          },
          runId,
          stage: 'research',
          status: 'warning',
          summary: 'Research draft LLM call failed; using template fallback.',
        });
        draftBody = buildTemplateDraft(opp, sourceItems, searchItems);
      }
    } else {
      logger.log('No ANTHROPIC_API_KEY — using template draft.');
      recordRunEvent(db, {
        actor: requestedBy,
        eventType: 'fallback.used',
        opportunityId: Number(opp.id),
        payload: {
          ...promptMetadata,
          fallback: 'template_draft',
          reason: 'ANTHROPIC_API_KEY missing',
        },
        runId,
        stage: 'research',
        status: 'warning',
        summary: 'LLM unavailable; using template draft.',
      });
      draftBody = buildTemplateDraft(opp, sourceItems, searchItems);
    }

    const draft: ResearchDraft = {
      opportunity_slug: opp.slug,
      ...draftBody,
      source_refs: [
        ...new Set([
          ...sourceItems.map((s: any) => s.id),
          ...searchItems.map((s) => s.id),
        ]),
      ],
    };

    db.prepare(
      "UPDATE runs SET status = 'draft_ready', metadata_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({
        draft,
        prompt_metadata: promptMetadata,
        research_trace: {
          source_item_count: sourceItems.length,
          external_search: searchTrace,
        },
      }),
      runId,
    );
    recordRunEvent(db, {
      actor: requestedBy,
      eventType: 'research.draft_ready',
      opportunityId: Number(opp.id),
      payload: {
        ...promptMetadata,
        publication_mode: 'artifact',
        source_item_count: sourceItems.length,
      },
      runId,
      stage: 'research',
      status: 'ok',
      summary: `Research draft ready for ${opp.slug}.`,
    });

    const { path } = publishResearchArtifact(db, runId, publicationNotes);
    logger.log(`Research artifact published for run #${runId}.`);
    logger.log(`Artifact written: ${path}`);
    emitParentEvent({
      actor: requestedBy,
      eventType: 'research.artifact_published',
      opportunityId: Number(opp.id),
      payload: { artifact_path: path, child_run_id: runId },
      stage: 'process-opportunities',
      status: 'ok',
      summary: `Artifact published for ${opp.slug}.`,
    });

    return {
      artifactPath: path,
      opportunityId: Number(opp.id),
      opportunitySlug: opp.slug,
      runId,
      status: 'published',
    };
  } catch (err) {
    if (runId !== null) {
      markRunFailed(err instanceof Error ? err.message : String(err));
    }
    throw err;
  } finally {
    removeSignalHandlers();
    if (ownsDb) {
      closeDb();
    }
  }
}
