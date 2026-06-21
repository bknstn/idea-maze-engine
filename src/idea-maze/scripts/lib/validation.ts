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


export interface ValidatedExplorationBrief {
  thesis: string;
  icp: {
    buyer: string;
    user: string;
    trigger: string;
    current_workaround: string;
    budget_owner: string;
  };
  evidence_summary: Array<{
    source_type: string;
    quote_or_summary: string;
    interpretation: string;
    evidence_role: string;
  }>;
  competitor_map: Array<{
    name: string;
    category: string;
    positioning: string;
    weakness: string;
  }>;
  workflow_wedge: {
    narrow_workflow: string;
    must_have_features: string[];
    explicit_non_goals: string[];
  };
  interview_script: string[];
  smoke_test: {
    audience: string;
    offer: string;
    channel: string;
    success_metric: string;
  };
  pricing_hypothesis: string;
  kill_criteria: string[];
  open_questions: string[];
  next_action: string;
}

function validateObjectArray<T>(
  value: unknown,
  path: string,
  errors: string[],
  mapper: (object: Record<string, unknown>, itemPath: string, errors: string[]) => T | null,
): T[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return null;
  }
  const out: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const itemPath = `${path}[${index}]`;
    const object = validateObject(value[index], itemPath, errors);
    if (!object) continue;
    const mapped = mapper(object, itemPath, errors);
    if (mapped) out.push(mapped);
  }
  return out.length === value.length ? out : null;
}

export function validateExplorationBrief(
  input: unknown,
): ValidationResult<ValidatedExplorationBrief> {
  const errors: string[] = [];
  const object = validateObject(input, 'brief', errors);
  if (!object) return { errors, value: null };

  const thesis = validateString(object.thesis, 'brief.thesis', errors);
  const icpObject = validateObject(object.icp, 'brief.icp', errors);
  const icp = icpObject
    ? {
        buyer: validateString(icpObject.buyer, 'brief.icp.buyer', errors),
        user: validateString(icpObject.user, 'brief.icp.user', errors),
        trigger: validateString(icpObject.trigger, 'brief.icp.trigger', errors),
        current_workaround: validateString(icpObject.current_workaround, 'brief.icp.current_workaround', errors),
        budget_owner: validateString(icpObject.budget_owner, 'brief.icp.budget_owner', errors),
      }
    : null;
  const evidenceSummary = validateObjectArray(object.evidence_summary, 'brief.evidence_summary', errors, (item, itemPath, itemErrors) => {
    const source_type = validateString(item.source_type, `${itemPath}.source_type`, itemErrors);
    const quote_or_summary = validateString(item.quote_or_summary, `${itemPath}.quote_or_summary`, itemErrors);
    const interpretation = validateString(item.interpretation, `${itemPath}.interpretation`, itemErrors);
    const evidence_role = validateString(item.evidence_role, `${itemPath}.evidence_role`, itemErrors);
    return source_type && quote_or_summary && interpretation && evidence_role ? { source_type, quote_or_summary, interpretation, evidence_role } : null;
  });
  const competitorMap = validateObjectArray(object.competitor_map, 'brief.competitor_map', errors, (item, itemPath, itemErrors) => {
    const name = validateString(item.name, `${itemPath}.name`, itemErrors);
    const category = validateString(item.category, `${itemPath}.category`, itemErrors);
    const positioning = validateString(item.positioning, `${itemPath}.positioning`, itemErrors);
    const weakness = validateString(item.weakness, `${itemPath}.weakness`, itemErrors);
    return name && category && positioning && weakness ? { name, category, positioning, weakness } : null;
  });
  const wedgeObject = validateObject(object.workflow_wedge, 'brief.workflow_wedge', errors);
  const workflowWedge = wedgeObject
    ? {
        narrow_workflow: validateString(wedgeObject.narrow_workflow, 'brief.workflow_wedge.narrow_workflow', errors),
        must_have_features: validateStringArray(wedgeObject.must_have_features, 'brief.workflow_wedge.must_have_features', errors),
        explicit_non_goals: validateStringArray(wedgeObject.explicit_non_goals, 'brief.workflow_wedge.explicit_non_goals', errors),
      }
    : null;
  const interviewScript = validateStringArray(object.interview_script, 'brief.interview_script', errors);
  const smokeObject = validateObject(object.smoke_test, 'brief.smoke_test', errors);
  const smokeTest = smokeObject
    ? {
        audience: validateString(smokeObject.audience, 'brief.smoke_test.audience', errors),
        offer: validateString(smokeObject.offer, 'brief.smoke_test.offer', errors),
        channel: validateString(smokeObject.channel, 'brief.smoke_test.channel', errors),
        success_metric: validateString(smokeObject.success_metric, 'brief.smoke_test.success_metric', errors),
      }
    : null;
  const pricingHypothesis = validateString(object.pricing_hypothesis, 'brief.pricing_hypothesis', errors);
  const killCriteria = validateStringArray(object.kill_criteria, 'brief.kill_criteria', errors);
  const openQuestions = validateStringArray(object.open_questions, 'brief.open_questions', errors);
  const nextAction = validateString(object.next_action, 'brief.next_action', errors);

  if (errors.length || !icp || !workflowWedge || !smokeTest) return { errors, value: null };
  return {
    errors,
    value: {
      thesis: thesis!,
      icp: {
        buyer: icp.buyer!, user: icp.user!, trigger: icp.trigger!, current_workaround: icp.current_workaround!, budget_owner: icp.budget_owner!,
      },
      evidence_summary: evidenceSummary!,
      competitor_map: competitorMap!,
      workflow_wedge: {
        narrow_workflow: workflowWedge.narrow_workflow!, must_have_features: workflowWedge.must_have_features!, explicit_non_goals: workflowWedge.explicit_non_goals!,
      },
      interview_script: interviewScript!,
      smoke_test: { audience: smokeTest.audience!, offer: smokeTest.offer!, channel: smokeTest.channel!, success_metric: smokeTest.success_metric! },
      pricing_hypothesis: pricingHypothesis!,
      kill_criteria: killCriteria!,
      open_questions: openQuestions!,
      next_action: nextAction!,
    },
  };
}
