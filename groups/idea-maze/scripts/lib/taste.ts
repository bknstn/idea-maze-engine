import type Database from 'better-sqlite3';

import {
  clampScore,
  type OpportunityScoreSet,
  updateOpportunityScores,
} from './opportunity-state.ts';

export const FEATURE_TYPE_WEIGHTS = {
  cluster_key: 0.4,
  source_origin: 0.05,
  source_pattern: 0.25,
  harvest_signal: 0.2,
  insight_type: 0.1,
} as const;

export type FeatureType = keyof typeof FEATURE_TYPE_WEIGHTS;

export interface OpportunityFeatureSnapshot {
  cluster_key: string[];
  harvest_signal: string[];
  insight_type: string[];
  source_origin: string[];
  source_pattern: string[];
}

export interface MatchedTasteFeature {
  featureType: FeatureType;
  featureValue: string;
  learnedWeight: number;
}

export interface TasteComputation {
  finalScore: number;
  learnedAdjustment: number;
  marketScore: number;
  matchedFeatures: MatchedTasteFeature[];
  preferenceAdjustment: number;
  preferenceSignals: Array<{
    matchedTerms: string[];
    score: number;
    signal: string;
  }>;
  tasteAdjustment: number;
  typeScores: Record<FeatureType, number>;
}

interface FounderPreferenceRule {
  maxMagnitude: number;
  perMatch: number;
  signal: string;
  terms: string[];
}

const FOUNDER_PREFERENCE_RULES: FounderPreferenceRule[] = [
  {
    signal: 'low_ticket_subscription',
    perMatch: 0.18,
    maxMagnitude: 0.55,
    terms: [
      '$5',
      '$9',
      '$10',
      '$15',
      '$19',
      '$20',
      '$25',
      '$29',
      '$30',
      '$39',
      '$49',
      '$50',
      'subscription',
      'subscription app',
      'monthly plan',
      'monthly subscription',
      'per month',
      '/month',
    ],
  },
  {
    signal: 'self_serve_distribution',
    perMatch: 0.15,
    maxMagnitude: 0.45,
    terms: [
      'buy online',
      'checkout',
      'credit card',
      'instant setup',
      'no demo',
      'no sales call',
      'self serve',
      'self-serve',
      'sign up and pay',
      'start trial',
    ],
  },
  {
    signal: 'small_operator_buyer',
    perMatch: 0.12,
    maxMagnitude: 0.35,
    terms: [
      'agency owner',
      'consultant',
      'creator',
      'freelancer',
      'indie hacker',
      'micro business',
      'one-person',
      'small business',
      'solo founder',
      'tiny team',
      'two-person',
    ],
  },
  {
    signal: 'enterprise_sales_motion',
    perMatch: -0.22,
    maxMagnitude: 0.88,
    terms: [
      'annual contract',
      'book a demo',
      'book demo',
      'contact sales',
      'custom quote',
      'enterprise',
      'enterprise-grade',
      'fortune 500',
      'legal review',
      'procurement',
      'sales led',
      'sales-led',
      'security review',
      'vendor review',
    ],
  },
  {
    signal: 'compliance_heavy_scope',
    perMatch: -0.18,
    maxMagnitude: 0.54,
    terms: ['okta', 'saml', 'scim', 'soc 2', 'soc2', 'vendor questionnaire'],
  },
  {
    signal: 'high_touch_delivery',
    perMatch: -0.16,
    maxMagnitude: 0.48,
    terms: [
      'account executive',
      'account manager',
      'customer success',
      'dedicated support',
      'implementation',
      'onboarding team',
      'professional services',
      'solution engineer',
      'white glove',
    ],
  },
];

function normalizeFeatureValue(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values
        .map(normalizeFeatureValue)
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildBoundedRuleScore(
  matchCount: number,
  perMatch: number,
  maxMagnitude: number,
): number {
  if (!matchCount) return 0;
  const raw = matchCount * perMatch;
  if (raw > 0) return round2(Math.min(maxMagnitude, raw));
  return round2(Math.max(-maxMagnitude, raw));
}

function toSnapshot(
  record: Record<string, string[]>,
): OpportunityFeatureSnapshot {
  return {
    cluster_key: dedupe(record.cluster_key ?? []),
    harvest_signal: dedupe(record.harvest_signal ?? []),
    insight_type: dedupe(record.insight_type ?? []),
    source_origin: dedupe(record.source_origin ?? []),
    source_pattern: dedupe(record.source_pattern ?? []),
  };
}

export function extractOpportunityFeatures(
  db: Database.Database,
  opportunityId: number,
): OpportunityFeatureSnapshot {
  const opportunity = db
    .prepare(
      `
    SELECT cluster_key
    FROM opportunities
    WHERE id = ?
  `,
    )
    .get(opportunityId) as { cluster_key: string } | undefined;
  if (!opportunity) {
    throw new Error(`Opportunity #${opportunityId} not found.`);
  }

  const sourceRows = db
    .prepare(
      `
    SELECT si.source, si.metadata_json
    FROM source_items si
    JOIN opportunity_sources os ON os.source_item_id = si.id
    WHERE os.opportunity_id = ?
  `,
    )
    .all(opportunityId) as Array<{ metadata_json: string; source: string }>;

  const insightRows = db
    .prepare(
      `
    SELECT DISTINCT i.insight_type
    FROM insights i
    JOIN opportunity_sources os ON os.source_item_id = i.source_item_id
    WHERE os.opportunity_id = ?
  `,
    )
    .all(opportunityId) as Array<{ insight_type: string }>;

  const sourcePatterns: string[] = [];
  const harvestSignals: string[] = [];
  for (const row of sourceRows) {
    try {
      const parsed = JSON.parse(row.metadata_json);
      if (Array.isArray(parsed.source_patterns)) {
        sourcePatterns.push(...parsed.source_patterns);
      }
      if (Array.isArray(parsed.harvest_signals)) {
        harvestSignals.push(...parsed.harvest_signals);
      }
    } catch {
      // Ignore malformed metadata when computing taste features.
    }
  }

  return toSnapshot({
    cluster_key: [opportunity.cluster_key],
    harvest_signal: harvestSignals,
    insight_type: insightRows.map((row) => row.insight_type),
    source_origin: sourceRows.map((row) => row.source),
    source_pattern: sourcePatterns,
  });
}

function collectFeatureValues(snapshot: OpportunityFeatureSnapshot): Array<{
  featureType: FeatureType;
  featureValue: string;
}> {
  const entries: Array<{ featureType: FeatureType; featureValue: string }> = [];
  for (const featureType of Object.keys(
    FEATURE_TYPE_WEIGHTS,
  ) as FeatureType[]) {
    for (const featureValue of snapshot[featureType]) {
      entries.push({ featureType, featureValue });
    }
  }
  return entries;
}

function buildOpportunityHaystack(
  db: Database.Database,
  opportunityId: number,
): string {
  const opportunity = db
    .prepare(
      `
    SELECT title, thesis, cluster_key
    FROM opportunities
    WHERE id = ?
  `,
    )
    .get(opportunityId) as
    | {
        cluster_key: string;
        thesis: string | null;
        title: string | null;
      }
    | undefined;
  if (!opportunity) {
    throw new Error(`Opportunity #${opportunityId} not found.`);
  }

  const sourceRows = db
    .prepare(
      `
    SELECT si.author, si.canonical_url, si.channel_or_label, si.title, si.text
    FROM source_items si
    JOIN opportunity_sources os ON os.source_item_id = si.id
    WHERE os.opportunity_id = ?
  `,
    )
    .all(opportunityId) as Array<{
    author: string | null;
    canonical_url: string | null;
    channel_or_label: string | null;
    text: string | null;
    title: string | null;
  }>;

  return [
    opportunity.title ?? '',
    opportunity.thesis ?? '',
    opportunity.cluster_key.replace(/-/g, ' '),
    ...sourceRows.flatMap((row) => [
      row.author ?? '',
      row.canonical_url ?? '',
      row.channel_or_label ?? '',
      row.title ?? '',
      row.text ?? '',
    ]),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function computeFounderPreferenceAdjustment(
  db: Database.Database,
  opportunityId: number,
): {
  adjustment: number;
  signals: Array<{
    matchedTerms: string[];
    score: number;
    signal: string;
  }>;
} {
  const haystack = buildOpportunityHaystack(db, opportunityId);
  const signals = FOUNDER_PREFERENCE_RULES.flatMap((rule) => {
    const matchedTerms = rule.terms.filter((term) => haystack.includes(term));
    if (!matchedTerms.length) return [];
    const score = buildBoundedRuleScore(
      matchedTerms.length,
      rule.perMatch,
      rule.maxMagnitude,
    );
    if (!score) return [];
    return [
      {
        matchedTerms: matchedTerms.slice(0, 4),
        score,
        signal: rule.signal,
      },
    ];
  }).sort((a, b) => a.signal.localeCompare(b.signal));

  const adjustment = round2(
    Math.max(
      -1.2,
      Math.min(
        1.2,
        signals.reduce((sum, signal) => sum + signal.score, 0),
      ),
    ),
  );
  return { adjustment, signals };
}

export function updateTasteProfileFromPublicationSignal(
  db: Database.Database,
  input: {
    opportunityId: number;
    runId: number;
    signal: 'published' | 'ignored';
  },
): void {
  const now = new Date().toISOString();
  const snapshot = extractOpportunityFeatures(db, input.opportunityId);
  const features = collectFeatureValues(snapshot);
  const deltaApproved = input.signal === 'published' ? 1 : 0;
  const deltaRejected = input.signal === 'ignored' ? 1 : 0;

  const insertFeedback = db.prepare(`
    INSERT OR IGNORE INTO feedback_features (
      run_id,
      opportunity_id,
      decision,
      feature_type,
      feature_value,
      created_at_utc
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertProfile = db.prepare(`
    INSERT OR IGNORE INTO taste_profile (
      feature_type,
      feature_value,
      approved_count,
      rejected_count,
      learned_weight,
      updated_at_utc
    )
    VALUES (?, ?, 0, 0, 0, ?)
  `);
  const updateProfile = db.prepare(`
    UPDATE taste_profile
    SET approved_count = approved_count + ?,
        rejected_count = rejected_count + ?,
        learned_weight = CAST(
          (approved_count + ?) - (rejected_count + ?)
          AS REAL
        ) / CAST((approved_count + ?) + (rejected_count + ?) + 2 AS REAL),
        updated_at_utc = ?
    WHERE feature_type = ? AND feature_value = ?
  `);

  for (const feature of features) {
    insertFeedback.run(
      input.runId,
      input.opportunityId,
      input.signal,
      feature.featureType,
      feature.featureValue,
      now,
    );
    insertProfile.run(feature.featureType, feature.featureValue, now);
    updateProfile.run(
      deltaApproved,
      deltaRejected,
      deltaApproved,
      deltaRejected,
      deltaApproved,
      deltaRejected,
      now,
      feature.featureType,
      feature.featureValue,
    );
  }
}

export function computeTasteForSnapshot(
  db: Database.Database,
  marketScore: number,
  snapshot: OpportunityFeatureSnapshot,
): TasteComputation {
  const matchedFeatures: MatchedTasteFeature[] = [];
  const typeScores = {
    cluster_key: 0,
    harvest_signal: 0,
    insight_type: 0,
    source_origin: 0,
    source_pattern: 0,
  } satisfies Record<FeatureType, number>;

  const findProfile = db.prepare(`
    SELECT learned_weight
    FROM taste_profile
    WHERE feature_type = ? AND feature_value = ?
  `);

  let weightedSum = 0;
  for (const featureType of Object.keys(
    FEATURE_TYPE_WEIGHTS,
  ) as FeatureType[]) {
    const weights: number[] = [];
    for (const featureValue of snapshot[featureType]) {
      const row = findProfile.get(featureType, featureValue) as
        | { learned_weight: number }
        | undefined;
      if (!row) continue;
      const learnedWeight = Number(row.learned_weight) || 0;
      weights.push(learnedWeight);
      matchedFeatures.push({ featureType, featureValue, learnedWeight });
    }
    const typeScore = mean(weights);
    typeScores[featureType] = round2(typeScore);
    weightedSum += typeScore * FEATURE_TYPE_WEIGHTS[featureType];
  }

  const tasteAdjustment = round2(
    Math.max(-1.5, Math.min(1.5, 1.5 * weightedSum)),
  );
  const finalScore = clampScore(round2(marketScore + tasteAdjustment));

  return {
    finalScore,
    learnedAdjustment: tasteAdjustment,
    marketScore: clampScore(marketScore),
    matchedFeatures: matchedFeatures.sort((a, b) => {
      if (a.featureType !== b.featureType)
        return a.featureType.localeCompare(b.featureType);
      return a.featureValue.localeCompare(b.featureValue);
    }),
    preferenceAdjustment: 0,
    preferenceSignals: [],
    tasteAdjustment,
    typeScores,
  };
}

export function computeTasteForOpportunity(
  db: Database.Database,
  opportunityId: number,
  marketScore: number,
): TasteComputation {
  const learned = computeTasteForSnapshot(
    db,
    marketScore,
    extractOpportunityFeatures(db, opportunityId),
  );
  const preference = computeFounderPreferenceAdjustment(db, opportunityId);
  const tasteAdjustment = round2(
    Math.max(
      -1.5,
      Math.min(1.5, learned.tasteAdjustment + preference.adjustment),
    ),
  );
  const finalScore = clampScore(round2(learned.marketScore + tasteAdjustment));

  return {
    ...learned,
    finalScore,
    learnedAdjustment: learned.tasteAdjustment,
    preferenceAdjustment: preference.adjustment,
    preferenceSignals: preference.signals,
    tasteAdjustment,
  };
}

export function recomputeOpportunityScore(
  db: Database.Database,
  opportunityId: number,
  marketScore: number,
): OpportunityScoreSet {
  const computed = computeTasteForOpportunity(db, opportunityId, marketScore);
  const scores = {
    finalScore: computed.finalScore,
    marketScore: computed.marketScore,
    tasteAdjustment: computed.tasteAdjustment,
  };
  updateOpportunityScores(db, opportunityId, scores);
  return scores;
}

export function recomputeAllOpportunityScores(db: Database.Database): void {
  const opportunities = db
    .prepare(
      `
    SELECT id, market_score, score
    FROM opportunities
  `,
    )
    .all() as Array<{ id: number; market_score: number; score: number }>;

  for (const opportunity of opportunities) {
    const marketScore =
      Number.isFinite(Number(opportunity.market_score)) &&
      Number(opportunity.market_score) > 0
        ? Number(opportunity.market_score)
        : Number(opportunity.score) || 0;
    recomputeOpportunityScore(db, opportunity.id, marketScore);
  }
}
