import type { EvidenceQualityResult } from './evidence-quality.ts';

export const AUTO_PUBLISH_MIN_BUCKET = 9;

export type OpportunityDisposition = 'ignore' | 'publish_artifact';

export interface OpportunityPolicy {
  bucket: number;
  disposition: OpportunityDisposition;
}

export interface OpportunityPolicyInput {
  finalScore: number;
  evidenceQuality?: EvidenceQualityResult;
}

export function getOpportunityScoreBucket(score: number): number {
  const normalized = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(10, Math.floor(normalized)));
}

export function classifyOpportunityForAutomation(
  input: OpportunityPolicyInput,
): OpportunityPolicy {
  const evidenceQuality = input.evidenceQuality;
  const effectiveScore = evidenceQuality
    ? Math.min(input.finalScore, evidenceQuality.adjustedMaxScore)
    : input.finalScore;

  if (evidenceQuality && evidenceQuality.disposition !== 'review_eligible') {
    return { bucket: getOpportunityScoreBucket(effectiveScore), disposition: 'ignore' };
  }

  return classifyOpportunityScore(effectiveScore);
}

export function classifyOpportunityScore(score: number): OpportunityPolicy {
  const bucket = getOpportunityScoreBucket(score);
  if (bucket >= AUTO_PUBLISH_MIN_BUCKET) {
    return { bucket, disposition: 'publish_artifact' };
  }
  return { bucket, disposition: 'ignore' };
}
