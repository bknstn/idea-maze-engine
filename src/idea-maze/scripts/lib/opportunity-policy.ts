export const AUTO_PUBLISH_MIN_BUCKET = 9;

export type OpportunityDisposition = 'ignore' | 'publish_artifact';

export interface OpportunityPolicy {
  bucket: number;
  disposition: OpportunityDisposition;
}

export function getOpportunityScoreBucket(score: number): number {
  const normalized = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(10, Math.floor(normalized)));
}

export function classifyOpportunityScore(score: number): OpportunityPolicy {
  const bucket = getOpportunityScoreBucket(score);
  if (bucket >= AUTO_PUBLISH_MIN_BUCKET) {
    return { bucket, disposition: 'publish_artifact' };
  }
  return { bucket, disposition: 'ignore' };
}
