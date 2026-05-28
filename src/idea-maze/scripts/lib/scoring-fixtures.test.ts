import { describe, expect, it } from 'vitest';
import { scoreSourceItem } from './scoring.ts';

type ScoringCase = {
  label: 'strong_daily_pain' | 'weak_daily_noise' | 'strong_business_pain' | 'business_false_positive_daily_terms' | 'megathread_noise' | 'promotional_showcase';
  title: string;
  text: string;
  subreddit: string;
  expectedSignals?: string[];
  excludedSignals?: string[];
  minScore?: number;
  maxScore?: number;
};

const cases: ScoringCase[] = [
  {
    label: 'strong_daily_pain',
    title: 'Plateau after deload and recovery is confusing',
    text: 'My workout recovery and soreness keep getting stuck. I need help planning deload weeks and tracking what changes actually work.',
    subreddit: 'r/bodyweightfitness',
    expectedSignals: ['health-fitness', 'routine-friction'],
    minScore: 0.55,
  },
  {
    label: 'strong_daily_pain',
    title: 'Retention backlog keeps growing',
    text: 'My Anki reviews and spaced repetition plan are falling apart, recall is bad, and I keep forgetting language learning cards.',
    subreddit: 'r/Anki',
    expectedSignals: ['learning-memory', 'tracking-planning'],
    minScore: 0.55,
  },
  {
    label: 'strong_daily_pain',
    title: 'Need help with onebag itinerary and visa timing',
    text: 'I am stuck planning flights, visa rules, budget, booking, safety, and carry-on packing for a multi-country trip.',
    subreddit: 'r/solotravel',
    expectedSignals: ['travel-logistics', 'complaint-language'],
    minScore: 0.55,
  },
  {
    label: 'weak_daily_noise',
    title: 'Believe in yourself today',
    text: 'You can do it. Stay positive and thank you community for the motivation.',
    subreddit: 'r/selfimprovement',
    excludedSignals: ['routine-friction', 'productivity-friction'],
    maxScore: 0.55,
  },
  {
    label: 'weak_daily_noise',
    title: 'Success story after a year of studying',
    text: 'I made it and wanted to share encouragement. No problem, just gratitude and motivation.',
    subreddit: 'r/GetStudying',
    maxScore: 0.55,
  },
  {
    label: 'strong_business_pain',
    title: 'Manual invoice reconciliation across client spreadsheets',
    text: 'We copy-paste CSV exports by hand, reconcile contractor invoices, and the approval workflow blocks billing every month.',
    subreddit: 'r/SaaS',
    expectedSignals: ['manual-work', 'workflow-context', 'existing-spend'],
    minScore: 0.55,
  },
  {
    label: 'strong_business_pain',
    title: 'Support ticket handoff process is broken',
    text: 'Customer support triage has a slow queue and repeated follow-up steps. We pay contractors to stitch together exports.',
    subreddit: 'r/startups',
    expectedSignals: ['workflow-context', 'existing-spend'],
    minScore: 0.55,
  },
  {
    label: 'business_false_positive_daily_terms',
    title: 'Please review my SaaS onboarding form',
    text: 'We are running an agency program and want feedback on a pricing page, signup form, and onboarding copy.',
    subreddit: 'r/SaaS',
    excludedSignals: ['health-fitness', 'learning-memory', 'travel-logistics'],
  },
  {
    label: 'business_false_positive_daily_terms',
    title: 'Travel program landing page review',
    text: 'A B2B travel management landing page needs copy review, demo form feedback, and enterprise pricing suggestions.',
    subreddit: 'r/startups',
    excludedSignals: ['travel-logistics', 'health-fitness', 'learning-memory'],
    maxScore: 0.8,
  },
  {
    label: 'megathread_noise',
    title: 'Bag finder megathread',
    text: 'Weekly thread for onebag packing lists, itinerary ideas, carry-on gear, booking links, and general recommendations.',
    subreddit: 'r/onebag',
    expectedSignals: ['weak-pain-evidence'],
    maxScore: 0.55,
  },
  {
    label: 'megathread_noise',
    title: 'Daily thread: study plans and check-ins',
    text: 'Share your schedule, flashcards, retention stats, and language learning updates in this daily thread.',
    subreddit: 'r/GetStudying',
    expectedSignals: ['weak-pain-evidence'],
    maxScore: 0.55,
  },
  {
    label: 'promotional_showcase',
    title: 'My setup for focus and habit tracking',
    text: 'Rate my Notion template and todo dashboard. What would you optimize in this productivity setup?',
    subreddit: 'r/productivity',
    maxScore: 0.55,
  },
];

function scoreCase(testCase: ScoringCase) {
  return scoreSourceItem({
    source: 'reddit',
    title: testCase.title,
    text: testCase.text,
    canonical_url: `https://www.reddit.com/${testCase.subreddit}/comments/example/example/`,
    metadata: {
      subreddit: testCase.subreddit,
      score: 12,
      num_comments: 8,
      upvote_ratio: 0.82,
    },
  });
}

describe('reddit scoring calibration fixtures', () => {
  for (const testCase of cases) {
    it(`${testCase.label}: ${testCase.title}`, () => {
      const result = scoreCase(testCase);

      for (const signal of testCase.expectedSignals ?? []) {
        expect(result.signals).toContain(signal);
      }
      for (const signal of testCase.excludedSignals ?? []) {
        expect(result.signals).not.toContain(signal);
      }
      if (testCase.minScore !== undefined) {
        expect(result.score).toBeGreaterThanOrEqual(testCase.minScore);
      }
      if (testCase.maxScore !== undefined) {
        expect(result.score).toBeLessThan(testCase.maxScore);
      }
    });
  }
});
