import { describe, expect, it } from 'vitest';
import { scoreSourceItem } from './scoring.ts';

function scoreRedditPost(title: string, text: string, subreddit: string) {
  return scoreSourceItem({
    source: 'reddit',
    title,
    text,
    canonical_url: `https://www.reddit.com/r/${subreddit}/comments/example/example/`,
    metadata: {
      subreddit: `r/${subreddit}`,
      score: 12,
      num_comments: 8,
      upvote_ratio: 0.82,
    },
  });
}

describe('scoreSourceItem daily-routine harvest signals', () => {
  it('scores gym recovery and plateau posts as health-fitness routine pain', () => {
    const result = scoreRedditPost(
      'Plateau and recovery tracking is confusing',
      'I keep getting stuck after deload weeks. My sleep and soreness are all over the place and I wish there was a simple way to adjust my program.',
      'bodyweightfitness',
    );

    expect(result.signals).toContain('health-fitness');
    expect(result.signals).toContain('routine-friction');
    expect(result.score).toBeGreaterThanOrEqual(0.55);
  });

  it('scores forgetting and spaced repetition posts as learning-memory pain', () => {
    const result = scoreRedditPost(
      'I forget everything after studying',
      'My Anki reviews pile up, retention is bad, and I feel overwhelmed trying to plan spaced repetition for language learning.',
      'Anki',
    );

    expect(result.signals).toContain('learning-memory');
    expect(result.signals).toContain('tracking-planning');
    expect(result.score).toBeGreaterThanOrEqual(0.55);
  });

  it('scores procrastination and focus posts as productivity routine pain', () => {
    const result = scoreRedditPost(
      'I cannot stick to my routine',
      'I procrastinate every morning, get distracted, and my todo list/calendar time blocking system keeps falling apart.',
      'productivity',
    );

    expect(result.signals).toContain('productivity-friction');
    expect(result.signals).toContain('routine-friction');
    expect(result.score).toBeGreaterThanOrEqual(0.55);
  });

  it('scores packing and itinerary logistics posts as travel planning pain', () => {
    const result = scoreRedditPost(
      'Onebag packing and itinerary planning is stressful',
      'I need to plan flights, visa rules, budget, carry-on packing, and bookings for a two month trip without missing steps.',
      'onebag',
    );

    expect(result.signals).toContain('travel-logistics');
    expect(result.signals).toContain('tracking-planning');
    expect(result.score).toBeGreaterThanOrEqual(0.55);
  });

  it('does not over-score generic motivational posts with no concrete friction', () => {
    const result = scoreRedditPost(
      'You can do it today',
      'Believe in yourself and stay positive. Every day is a new chance to become better.',
      'selfimprovement',
    );

    expect(result.signals).not.toContain('routine-friction');
    expect(result.signals).not.toContain('productivity-friction');
    expect(result.score).toBeLessThan(0.55);
  });

  it('does not infer health or memory pain from broad business wording and HTML', () => {
    const result = scoreSourceItem({
      source: 'reddit',
      title: 'Please review my SaaS landing page form',
      text: '<!-- SC_OFF --><div class="md"><p>We are running an agency and need feedback on a signup form, pricing page, and onboarding copy.</p><a href="https://www.reddit.com/r/SaaS/comments/example">comments</a></div>',
      canonical_url: 'https://www.reddit.com/r/SaaS/comments/example/example/',
      metadata: {
        subreddit: 'r/SaaS',
        score: 10,
        num_comments: 5,
        upvote_ratio: 0.75,
      },
    });

    expect(result.signals).not.toContain('health-fitness');
    expect(result.signals).not.toContain('learning-memory');
    expect(result.signals).not.toContain('travel-logistics');
  });
});
