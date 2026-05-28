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

  it('boosts topic-relevant health posts above the same text in a business subreddit', () => {
    const title = 'Plateau after deload and recovery is confusing';
    const text = 'My soreness, workout recovery, and deload schedule keep getting stuck and I need help adjusting.';

    const health = scoreRedditPost(title, text, 'bodyweightfitness');
    const business = scoreRedditPost(title, text, 'SaaS');

    expect(health.signals).toContain('health-fitness');
    expect(health.score).toBeGreaterThan(business.score);
  });

  it('boosts learning-memory posts in learning subreddits without business spend terms', () => {
    const result = scoreRedditPost(
      'Retention backlog keeps growing',
      'My Anki reviews, recall, and spaced repetition plan are falling apart and I keep forgetting words.',
      'Anki',
    );

    expect(result.signals).toContain('learning-memory');
    expect(result.breakdown.learning_memory).toBeGreaterThanOrEqual(0.18);
    expect(result.score).toBeGreaterThanOrEqual(0.55);
  });

  it('boosts travel logistics in travel subreddits over the same words in SaaS', () => {
    const title = 'Packing itinerary and visa planning is stressful';
    const text = 'I need a checklist for flights, visa rules, budget, booking, carry-on packing, and itinerary changes.';

    const travel = scoreRedditPost(title, text, 'onebag');
    const business = scoreRedditPost(title, text, 'SaaS');

    expect(travel.signals).toContain('travel-logistics');
    expect(travel.score).toBeGreaterThan(business.score);
  });

  it('does not over-score generic motivational posts with no concrete friction', () => {
    const result = scoreRedditPost(
      'You can do it today',
      'Believe in yourself and stay positive. Every day is a new chance to become better.',
      'selfimprovement',
    );

    expect(result.signals).not.toContain('routine-friction');
    expect(result.signals).not.toContain('productivity-friction');
    expect(result.patterns).toContain('motivation-only');
    expect(result.score).toBeLessThan(0.55);
  });

  it('downweights daily routine megathreads without concrete user pain', () => {
    const result = scoreRedditPost(
      'Bag finder megathread',
      'Weekly thread for packing lists, carry-on recommendations, onebag setup links, itinerary ideas, and booking discussion.',
      'onebag',
    );

    expect(result.patterns).toContain('megathread-noise');
    expect(result.score).toBeLessThan(0.55);
  });

  it('keeps concrete need-help travel logistics posts eligible', () => {
    const result = scoreRedditPost(
      'Need help traveling to Cincinnati with visa and safety constraints',
      'I am stuck planning the itinerary, budget, visa timing, flight booking, safety tradeoffs, and carry-on packing for a short trip.',
      'solotravel',
    );

    expect(result.signals).toContain('travel-logistics');
    expect(result.signals).toContain('complaint-language');
    expect(result.score).toBeGreaterThanOrEqual(0.55);
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
