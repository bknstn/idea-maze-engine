import type Database from 'better-sqlite3';

export interface DuplicateGateResult {
  duplicate: boolean;
  matchedOpportunityId?: number;
  matchedSlug?: string;
  reasons: string[];
  similarity: number;
  sharedSourceIds: number[];
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'app',
  'for',
  'in',
  'is',
  'it',
  'my',
  'of',
  'on',
  'or',
  'our',
  'the',
  'this',
  'to',
  'tool',
  'with',
]);

interface RejectedOpportunityRow {
  cluster_key: string;
  id: number;
  slug: string;
  thesis: string;
  title: string;
}

function tokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function slugFamily(slug: string): string {
  return [...tokens(slug)].slice(0, 2).join('-');
}

function opportunityTokens(input: {
  cluster_key: string;
  slug: string;
  thesis: string;
  title: string;
}): Set<string> {
  return tokens(`${input.title} ${input.slug} ${input.cluster_key} ${input.thesis}`);
}

function getSourceIds(db: Database.Database, opportunityId: number): number[] {
  return (
    db
      .prepare('SELECT source_item_id FROM opportunity_sources WHERE opportunity_id = ?')
      .all(opportunityId) as { source_item_id: number }[]
  ).map((row) => Number(row.source_item_id));
}

export function findRejectedDuplicate(
  db: Database.Database,
  candidate: {
    id: number;
    slug: string;
    title: string;
    thesis: string;
    cluster_key: string;
  },
): DuplicateGateResult {
  const rejected = db
    .prepare(
      `
      SELECT id, slug, title, thesis, cluster_key
      FROM opportunities
      WHERE id != ?
        AND lifecycle_stage = 'rejected'
      ORDER BY updated_at_utc DESC
    `,
    )
    .all(candidate.id) as RejectedOpportunityRow[];

  const candidateTokens = opportunityTokens(candidate);
  const candidateSourceIds = getSourceIds(db, candidate.id);
  const candidateSourceSet = new Set(candidateSourceIds);
  const candidateFamily = slugFamily(candidate.slug);
  let best: DuplicateGateResult = {
    duplicate: false,
    reasons: [],
    sharedSourceIds: [],
    similarity: 0,
  };

  for (const rejectedOpp of rejected) {
    const rejectedSourceIds = getSourceIds(db, rejectedOpp.id);
    const sharedSourceIds = rejectedSourceIds.filter((id) => candidateSourceSet.has(id));
    const similarity = jaccard(candidateTokens, opportunityTokens(rejectedOpp));
    const reasons: string[] = [];
    if (sharedSourceIds.length > 0) reasons.push('shared_rejected_source');
    if (similarity > 0.55) reasons.push('similar_to_rejected');
    if (candidateFamily && candidateFamily === slugFamily(rejectedOpp.slug)) {
      reasons.push('same_slug_family');
    }

    const duplicate =
      (sharedSourceIds.length > 0 && similarity > 0.25) ||
      similarity > 0.55 ||
      reasons.includes('same_slug_family');

    if (duplicate && similarity >= best.similarity) {
      best = {
        duplicate: true,
        matchedOpportunityId: rejectedOpp.id,
        matchedSlug: rejectedOpp.slug,
        reasons,
        sharedSourceIds,
        similarity,
      };
    }
  }

  return best;
}
