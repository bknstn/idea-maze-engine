/**
 * Opportunity clustering — groups recent insights into opportunities.
 *
 * Ported from idea-maze-lab OpportunityService.refresh().
 * Clusters insights by top keyword, scores by weighted evidence,
 * and maintains opportunity_sources links.
 *
 * Usage: tsx refresh-opportunities.ts
 */

import { closeDb, getDb } from './lib/db.ts';
import {
  mergeOpportunityMetadata,
  setOpportunityLifecycle,
  type OpportunityLifecycleStage,
} from './lib/opportunity-state.ts';
import { classifyOpportunityScore } from './lib/opportunity-policy.ts';
import { withStageRunContext } from './lib/run-events.ts';
import { initSchema } from './lib/schema.ts';
import { recomputeOpportunityScore } from './lib/taste.ts';

// --- Helpers ---

const STOP_WORDS = new Set([
  // Articles, conjunctions, prepositions
  'a',
  'an',
  'the',
  'and',
  'or',
  'but',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'from',
  'into',
  'over',
  'such',
  'per',
  // Pronouns
  'it',
  'its',
  'they',
  'we',
  'you',
  'he',
  'she',
  'my',
  'our',
  'your',
  'their',
  'this',
  'that',
  'these',
  'those',
  'there',
  'who',
  'which',
  'what',
  'when',
  'where',
  'how',
  // Common verbs
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'get',
  'gets',
  'got',
  'use',
  'uses',
  'used',
  'make',
  'made',
  'need',
  'needs',
  'want',
  'wants',
  'can',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'let',
  'set',
  'run',
  // Common adverbs / filler
  'not',
  'just',
  'now',
  'than',
  'then',
  'also',
  'very',
  'more',
  'most',
  'some',
  'any',
  'all',
  'each',
  'every',
  'both',
  'few',
  'often',
  'still',
  'even',
  'only',
  'about',
  'like',
  'well',
  'already',
  'always',
  'never',
  'really',
  'quite',
  'rather',
  'much',
  'many',
  // Common generic adjectives
  'good',
  'new',
  'old',
  'big',
  'small',
  'large',
  'great',
  'high',
  'low',
  'long',
  'short',
  'same',
  'other',
  'own',
  'right',
  'next',
  'last',
  'little',
  'general',
  'clear',
  'actual',
  'certain',
  'free',
  'full',
  'able',
  'due',
  'real',
  'early',
  'easy',
  'hard',
  'simple',
  'true',
  'open',
  'public',
  'specific',
  'best',
  'better',
  'worse',
  'common',
  'around',
  'concrete',
  'actual',
  'honest',
  'boring',
  'genuine',
  'blind',
  'conscious',
  'brief',
  'correct',
  'dark',
  'direct',
  'done',
  // Pipeline template words
  'signal',
  'signals',
  'potential',
  'demand',
  'clue',
  'mentioned',
  'productized',
  'monitoring',
  'point',
  'constraint',
  'caveat',
  'opportunity',
  'insight',
  'around',
  'pricing',
]);

function topKeywords(texts: string[], limit = 2): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
    for (const token of tokens) {
      if (!STOP_WORDS.has(token)) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'untitled-opportunity'
  );
}

function harvestScoreFromMeta(metaStr: string): number {
  try {
    return Number(JSON.parse(metaStr).harvest_score) || 0;
  } catch {
    return 0;
  }
}

// --- Main ---

function main() {
  const db = getDb();
  initSchema(db);
  const stageRun = withStageRunContext(db, 'refresh-opportunities', {
    requestedBy: process.env.IDEA_MAZE_PARENT_RUN_ID ? 'system' : 'user',
  });

  try {
    const insights = db
      .prepare(
        `
      SELECT i.*, si.source as si_source, si.title as si_title, si.text as si_text,
             si.metadata_json as si_metadata_json
      FROM insights i
      JOIN source_items si ON si.id = i.source_item_id
      ORDER BY i.created_at_utc DESC
      LIMIT 500
    `,
      )
      .all() as any[];

    if (!insights.length) {
      console.log('No insights to cluster.');
      stageRun.finish('completed', 'No insights to cluster.', {
        archived: 0,
        created_or_updated: 0,
      });
      return;
    }

    console.log(`Clustering ${insights.length} recent insights...`);

    const clusters = new Map<string, any[]>();
    for (const insight of insights) {
      const sourceText = `${insight.si_title ?? ''} ${insight.si_text ?? ''}`;
      const keywords = topKeywords([sourceText, insight.summary], 3);
      const clusterKey = keywords[0] ?? insight.insight_type;
      if (!clusters.has(clusterKey)) clusters.set(clusterKey, []);
      clusters.get(clusterKey)!.push(insight);
    }

    console.log(`Found ${clusters.size} clusters.`);

    const now = new Date().toISOString();
    const upsertOpp = db.prepare(`
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
      VALUES (?, ?, ?, ?, ?, 0, ?, 'active', 'scored', ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        title = excluded.title,
        thesis = excluded.thesis,
        score = excluded.score,
        market_score = excluded.market_score,
        final_score = excluded.final_score,
        cluster_key = excluded.cluster_key,
        metadata_json = excluded.metadata_json,
        updated_at_utc = excluded.updated_at_utc
    `);
    const replaceSources = db.prepare(
      'DELETE FROM opportunity_sources WHERE opportunity_id = ?',
    );
    const linkSource = db.prepare(`
      INSERT OR IGNORE INTO opportunity_sources (opportunity_id, source_item_id)
      VALUES (?, ?)
    `);
    const getOpp = db.prepare(`
      SELECT id, lifecycle_stage, metadata_json
      FROM opportunities
      WHERE slug = ?
    `);
    const hasArtifact = db.prepare(
      'SELECT 1 FROM artifacts WHERE opportunity_id = ? LIMIT 1',
    );
    const hasPublishedRun = db.prepare(
      "SELECT 1 FROM runs WHERE target_id = ? AND status IN ('published', 'approved') LIMIT 1",
    );
    const hasOpenResearchRun = db.prepare(
      "SELECT 1 FROM runs WHERE target_id = ? AND status IN ('running', 'draft_ready', 'review_gate') LIMIT 1",
    );

    let archived = 0;
    let createdOrUpdated = 0;

    const MIN_INSIGHTS = 3;
    const filteredClusters = [...clusters.entries()].filter(
      ([, items]) => items.length >= MIN_INSIGHTS,
    );

    console.log(
      `Found ${clusters.size} raw clusters, ${filteredClusters.length} with ≥${MIN_INSIGHTS} insights.`,
    );

    for (const [clusterKey, clusterInsights] of filteredClusters) {
      const ranked = clusterInsights.sort((a: any, b: any) => {
        const scoreA =
          a.evidence_score + harvestScoreFromMeta(a.si_metadata_json);
        const scoreB =
          b.evidence_score + harvestScoreFromMeta(b.si_metadata_json);
        if (scoreB !== scoreA) return scoreB - scoreA;
        return (b.created_at_utc ?? '').localeCompare(a.created_at_utc ?? '');
      });

      const allText = ranked
        .map((i: any) => `${i.si_title ?? ''} ${i.si_text ?? ''} ${i.summary}`)
        .join(' ');
      const topWords = topKeywords([allText], 3);
      const bigramLabel = topWords.slice(0, 2).join('-') || clusterKey;
      const title = bigramLabel
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c: string) => c.toUpperCase());
      const slug = slugify(title);
      const thesis = ranked[0].summary;

      const sourceScores = ranked.map((i: any) =>
        harvestScoreFromMeta(i.si_metadata_json),
      );
      const avgSourceScore = sourceScores.length
        ? sourceScores.reduce((a: number, b: number) => a + b, 0) /
          sourceScores.length
        : 0;
      const uniqueSources = new Set(ranked.map((i: any) => i.si_source)).size;

      const weightedEvidence = ranked.reduce((sum: number, i: any) => {
        const hs = harvestScoreFromMeta(i.si_metadata_json);
        return sum + i.evidence_score * (1.0 + hs * 0.75);
      }, 0);

      const marketScore =
        Math.round(
          Math.min(
            10.0,
            weightedEvidence +
              avgSourceScore * 2.5 +
              uniqueSources * 0.4 +
              ranked.length * 0.2,
          ) * 100,
        ) / 100;

      const patternCounts = new Map<string, number>();
      const signalCounts = new Map<string, number>();
      for (const insight of ranked) {
        try {
          const meta = JSON.parse(insight.si_metadata_json);
          for (const pattern of meta.source_patterns ?? []) {
            patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
          }
          for (const signal of meta.harvest_signals ?? []) {
            signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1);
          }
        } catch {
          // Ignore malformed source metadata when deriving opportunity metadata.
        }
      }

      const metadata = {
        average_harvest_score: Math.round(avgSourceScore * 1000) / 1000,
        highlights: ranked.slice(0, 5).map((insight: any) => insight.summary),
        insight_count: ranked.length,
        market_score: marketScore,
        source_count: uniqueSources,
        top_harvest_signals: [...signalCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name]) => name),
        top_source_patterns: [...patternCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name]) => name),
      };

      upsertOpp.run(
        slug,
        title,
        thesis,
        marketScore,
        marketScore,
        marketScore,
        clusterKey,
        JSON.stringify(metadata),
        now,
        now,
      );

      const opportunity = getOpp.get(slug) as
        | {
            id: number;
            lifecycle_stage: OpportunityLifecycleStage | null;
            metadata_json: string;
          }
        | undefined;
      if (!opportunity) continue;

      replaceSources.run(opportunity.id);
      const seenSources = new Set<number>();
      for (const insight of ranked) {
        if (!seenSources.has(insight.source_item_id)) {
          linkSource.run(opportunity.id, insight.source_item_id);
          seenSources.add(insight.source_item_id);
        }
      }

      const scores = recomputeOpportunityScore(db, opportunity.id, marketScore);
      const policy = classifyOpportunityScore(scores.finalScore);

      const targetId = String(opportunity.id);
      const protectedHistory = Boolean(
        hasArtifact.get(opportunity.id) ||
        hasPublishedRun.get(targetId) ||
        hasOpenResearchRun.get(targetId),
      );

      const keepLifecycleForHistory =
        protectedHistory &&
        opportunity.lifecycle_stage &&
        ['artifact', 'researching'].includes(opportunity.lifecycle_stage);

      const nextLifecycle: OpportunityLifecycleStage =
        policy.disposition === 'ignore'
          ? keepLifecycleForHistory
            ? opportunity.lifecycle_stage!
            : 'archived'
          : 'scored';
      const nextStatus =
        policy.disposition === 'ignore' ? 'archived' : 'active';

      setOpportunityLifecycle(db, opportunity.id, nextLifecycle as any, {
        payload: {
          archive_reason:
            policy.disposition === 'ignore' ? 'low_score_filtered' : null,
          final_score: scores.finalScore,
          market_score: scores.marketScore,
          automation_disposition: policy.disposition,
          score_bucket: policy.bucket,
          taste_adjustment: scores.tasteAdjustment,
        },
        runId: stageRun.runId,
        status: nextStatus,
        summary:
          policy.disposition === 'ignore'
            ? `Opportunity archived after low-score filter (${scores.finalScore}).`
            : `Opportunity scored at ${scores.finalScore} and kept active.`,
      });

      db.prepare(
        `
        UPDATE opportunities
        SET metadata_json = ?
        WHERE id = ?
      `,
      ).run(
        mergeOpportunityMetadata(opportunity.metadata_json, {
          archive_reason:
            policy.disposition === 'ignore' ? 'low_score_filtered' : undefined,
          ...metadata,
          final_score: scores.finalScore,
          automation_disposition: policy.disposition,
          score_bucket: policy.bucket,
          taste_adjustment: scores.tasteAdjustment,
        }),
        opportunity.id,
      );

      if (policy.disposition === 'ignore') {
        archived++;
        console.log(
          `  ${slug}: market=${marketScore}, final=${scores.finalScore}, archived.`,
        );
      } else {
        console.log(
          `  ${slug}: market=${marketScore}, final=${scores.finalScore}, insights=${ranked.length}, sources=${uniqueSources}`,
        );
      }
      createdOrUpdated++;
    }

    console.log(
      `\nDone. ${createdOrUpdated} opportunities refreshed, ${archived} archived.`,
    );
    stageRun.finish(
      'completed',
      `Refreshed ${createdOrUpdated} opportunities.`,
      {
        archived,
        created_or_updated: createdOrUpdated,
        raw_clusters: clusters.size,
        scored_clusters: filteredClusters.length,
      },
    );
  } catch (err) {
    stageRun.finish(
      'error',
      `Opportunity refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  } finally {
    closeDb();
  }
}

main();
