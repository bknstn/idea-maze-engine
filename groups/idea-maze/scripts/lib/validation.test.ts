import { describe, expect, it } from 'vitest';

import {
  validateHarvestBatchResponse,
  validateResearchDraft,
} from './validation.ts';

describe('validateHarvestBatchResponse', () => {
  it('accepts well-formed harvest batches', () => {
    const result = validateHarvestBatchResponse({
      items: [
        {
          index: 0,
          insights: [
            {
              insight_type: 'pain_point',
              summary: 'Manual work keeps showing up.',
              evidence_score: 0.7,
              confidence: 0.8,
              metadata_json: {},
            },
          ],
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].insights[0].insight_type).toBe('pain_point');
  });

  it('rejects malformed entries and reports validation errors', () => {
    const result = validateHarvestBatchResponse({
      items: [
        {
          index: 0,
          insights: [
            {
              insight_type: 'not-real',
              summary: '',
              evidence_score: 3,
              confidence: -1,
              metadata_json: [],
            },
          ],
        },
      ],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].insights).toEqual([]);
    expect(result.errors.join(' ')).toContain('insight_type');
    expect(result.errors.join(' ')).toContain('evidence_score');
  });
});

describe('validateResearchDraft', () => {
  it('accepts complete research drafts', () => {
    const result = validateResearchDraft({
      thesis: 'Teams keep reconciling invoices by hand.',
      evidence_from_inbox: ['None'],
      evidence_from_telegram: ['None'],
      evidence_from_reddit: ['None'],
      external_market_check: ['None'],
      product_concept: 'Purpose-built finance workflow app',
      mvp_scope: ['Workflow intake'],
      implementation_plan: ['Build the narrow slice'],
      distribution_plan: ['Start in finance ops communities'],
      risks: ['Incumbents may react quickly'],
    });

    expect(result.errors).toEqual([]);
    expect(result.value?.product_concept).toContain('finance');
  });

  it('rejects drafts with wrong shapes', () => {
    const result = validateResearchDraft({
      thesis: '',
      evidence_from_inbox: 'None',
      evidence_from_telegram: [],
      evidence_from_reddit: [],
      external_market_check: [],
      product_concept: '',
      mvp_scope: [],
      implementation_plan: [],
      distribution_plan: [],
      risks: [],
    });

    expect(result.value).toBeNull();
    expect(result.errors.join(' ')).toContain('draft.thesis');
    expect(result.errors.join(' ')).toContain('draft.evidence_from_inbox');
  });
});
