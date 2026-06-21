import { describe, expect, it } from 'vitest';

import {
  validateExplorationBrief,
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


describe('validateExplorationBrief', () => {
  it('validates complete exploration briefs', () => {
    const result = validateExplorationBrief({
      thesis: 'Managers lose delegated tasks across voice, calls, and chat.',
      icp: {
        buyer: 'Owner-manager of a 5-20 person field-service team',
        user: 'Manager delegating work on the move',
        trigger: 'Tasks get lost after phone calls or site visits',
        current_workaround: 'WhatsApp, notes app, memory, spreadsheets',
        budget_owner: 'Owner-manager',
      },
      evidence_summary: [{ source_type: 'reddit', quote_or_summary: 'A manager asks for a voice-first delegation system.', interpretation: 'Direct workflow pain.', evidence_role: 'buyer_pain' }],
      competitor_map: [{ name: 'Todoist', category: 'task manager', positioning: 'General-purpose task capture', weakness: 'Not voice-first delegated-team follow-up' }],
      workflow_wedge: { narrow_workflow: 'Speak task → assign person → confirm → follow up', must_have_features: ['voice capture'], explicit_non_goals: ['full project management'] },
      interview_script: ['Tell me about the last delegated task that got lost.'],
      smoke_test: { audience: 'Managers of 5-20 person teams', offer: 'Voice-first delegation inbox', channel: 'Reddit/manual outreach', success_metric: '5 calls booked from 50 outreaches' },
      pricing_hypothesis: '$19-$49/month per manager',
      kill_criteria: ['Fewer than 3/10 buyers report lost delegated tasks weekly'],
      open_questions: ['Which communication channel matters first?'],
      next_action: 'Run 10 buyer interviews before building.',
    });
    expect(result.errors).toEqual([]);
    expect(result.value?.icp.buyer).toContain('Owner-manager');
  });

  it('rejects exploration briefs missing kill criteria', () => {
    const result = validateExplorationBrief({ thesis: 'Too thin' });
    expect(result.value).toBeNull();
    expect(result.errors).toContain('brief.kill_criteria must be an array');
  });
});
