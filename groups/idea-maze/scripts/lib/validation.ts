const INSIGHT_TYPES = new Set([
  'pain_point',
  'demand_signal',
  'workflow_gap',
  'distribution_clue',
  'willingness_to_pay',
  'competitor_move',
  'implementation_constraint',
]);

interface ValidationResult<T> {
  errors: string[];
  value: T | null;
}

export interface ValidatedHarvestBatch {
  errors: string[];
  items: Array<{
    index: number;
    insights: Array<{
      confidence: number;
      evidence_score: number;
      insight_type: string;
      metadata_json: Record<string, unknown>;
      summary: string;
    }>;
  }>;
}

function validateNumber(
  value: unknown,
  path: string,
  errors: string[],
): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.push(`${path} must be a number`);
    return null;
  }
  return value;
}

function validateString(
  value: unknown,
  path: string,
  errors: string[],
): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
    return null;
  }
  return value.trim();
}

function validateObject(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  return value as Record<string, unknown>;
}

function validateInsight(
  input: unknown,
  path: string,
): ValidationResult<{
  confidence: number;
  evidence_score: number;
  insight_type: string;
  metadata_json: Record<string, unknown>;
  summary: string;
}> {
  const errors: string[] = [];
  const object = validateObject(input, path, errors);
  if (!object) return { errors, value: null };

  const insightType = validateString(
    object.insight_type,
    `${path}.insight_type`,
    errors,
  );
  if (insightType && !INSIGHT_TYPES.has(insightType)) {
    errors.push(
      `${path}.insight_type must be one of ${[...INSIGHT_TYPES].join(', ')}`,
    );
  }

  const summary = validateString(object.summary, `${path}.summary`, errors);
  const evidenceScore = validateNumber(
    object.evidence_score,
    `${path}.evidence_score`,
    errors,
  );
  if (evidenceScore !== null && (evidenceScore < 0 || evidenceScore > 1)) {
    errors.push(`${path}.evidence_score must be between 0 and 1`);
  }
  const confidence = validateNumber(
    object.confidence,
    `${path}.confidence`,
    errors,
  );
  if (confidence !== null && (confidence < 0 || confidence > 1)) {
    errors.push(`${path}.confidence must be between 0 and 1`);
  }
  const metadataJson = validateObject(
    object.metadata_json ?? {},
    `${path}.metadata_json`,
    errors,
  );

  if (errors.length) return { errors, value: null };
  return {
    errors,
    value: {
      confidence: confidence!,
      evidence_score: evidenceScore!,
      insight_type: insightType!,
      metadata_json: metadataJson!,
      summary: summary!,
    },
  };
}

export function validateHarvestBatchResponse(
  input: unknown,
): ValidatedHarvestBatch {
  const errors: string[] = [];
  const object = validateObject(input, 'response', errors);
  const itemsRaw = object?.items;
  if (!Array.isArray(itemsRaw)) {
    errors.push('response.items must be an array');
    return { errors, items: [] };
  }

  const items: ValidatedHarvestBatch['items'] = [];
  for (let itemIndex = 0; itemIndex < itemsRaw.length; itemIndex++) {
    const itemPath = `response.items[${itemIndex}]`;
    const itemObject = validateObject(itemsRaw[itemIndex], itemPath, errors);
    if (!itemObject) continue;

    const index = validateNumber(itemObject.index, `${itemPath}.index`, errors);
    const insightsRaw = itemObject.insights;
    if (!Array.isArray(insightsRaw)) {
      errors.push(`${itemPath}.insights must be an array`);
      continue;
    }

    const insights: ValidatedHarvestBatch['items'][number]['insights'] = [];
    for (
      let insightIndex = 0;
      insightIndex < insightsRaw.length;
      insightIndex++
    ) {
      const result = validateInsight(
        insightsRaw[insightIndex],
        `${itemPath}.insights[${insightIndex}]`,
      );
      if (result.value) {
        insights.push(result.value);
      } else {
        errors.push(...result.errors);
      }
    }

    if (index !== null) {
      items.push({ index, insights });
    }
  }

  return { errors, items };
}

export interface ValidatedResearchDraft {
  distribution_plan: string[];
  evidence_from_inbox: string[];
  evidence_from_reddit: string[];
  evidence_from_telegram: string[];
  external_market_check: string[];
  implementation_plan: string[];
  mvp_scope: string[];
  product_concept: string;
  risks: string[];
  thesis: string;
}

function validateStringArray(
  value: unknown,
  path: string,
  errors: string[],
): string[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return null;
  }

  const items = value
    .map((entry, index) => validateString(entry, `${path}[${index}]`, errors))
    .filter((entry): entry is string => Boolean(entry));
  if (items.length !== value.length) {
    return null;
  }
  return items;
}

export function validateResearchDraft(
  input: unknown,
): ValidationResult<ValidatedResearchDraft> {
  const errors: string[] = [];
  const object = validateObject(input, 'draft', errors);
  if (!object) return { errors, value: null };

  const thesis = validateString(object.thesis, 'draft.thesis', errors);
  const evidenceFromInbox = validateStringArray(
    object.evidence_from_inbox,
    'draft.evidence_from_inbox',
    errors,
  );
  const evidenceFromTelegram = validateStringArray(
    object.evidence_from_telegram,
    'draft.evidence_from_telegram',
    errors,
  );
  const evidenceFromReddit = validateStringArray(
    object.evidence_from_reddit,
    'draft.evidence_from_reddit',
    errors,
  );
  const externalMarketCheck = validateStringArray(
    object.external_market_check,
    'draft.external_market_check',
    errors,
  );
  const productConcept = validateString(
    object.product_concept,
    'draft.product_concept',
    errors,
  );
  const mvpScope = validateStringArray(
    object.mvp_scope,
    'draft.mvp_scope',
    errors,
  );
  const implementationPlan = validateStringArray(
    object.implementation_plan,
    'draft.implementation_plan',
    errors,
  );
  const distributionPlan = validateStringArray(
    object.distribution_plan,
    'draft.distribution_plan',
    errors,
  );
  const risks = validateStringArray(object.risks, 'draft.risks', errors);

  if (errors.length) {
    return { errors, value: null };
  }

  return {
    errors,
    value: {
      distribution_plan: distributionPlan!,
      evidence_from_inbox: evidenceFromInbox!,
      evidence_from_reddit: evidenceFromReddit!,
      evidence_from_telegram: evidenceFromTelegram!,
      external_market_check: externalMarketCheck!,
      implementation_plan: implementationPlan!,
      mvp_scope: mvpScope!,
      product_concept: productConcept!,
      risks: risks!,
      thesis: thesis!,
    },
  };
}
