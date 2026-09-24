import {
  createEvidenceExcerpt,
  type EvidenceExcerptRole,
  type EvidenceExcerptV1,
  type SourceTextWindow,
} from './evidence-excerpts.ts';

export function groundEvidenceExcerpts(
  sourceItemId: number,
  sourceText: string,
  candidates: unknown,
  visibleRanges: SourceTextWindow[],
): { candidateCount: number; rejectedCount: number; excerpts: EvidenceExcerptV1[] } {
  if (!Array.isArray(candidates)) return { candidateCount: 0, rejectedCount: 0, excerpts: [] };
  const excerpts: EvidenceExcerptV1[] = [];
  let rejectedCount = Math.max(0, candidates.length - 4);
  for (const candidate of candidates.slice(0, 4)) {
    if (
      !candidate || typeof candidate !== 'object' || Array.isArray(candidate) ||
      typeof candidate.role !== 'string' || typeof candidate.quote !== 'string'
    ) {
      rejectedCount++;
      continue;
    }
    const excerpt = createEvidenceExcerpt({
      sourceItemId,
      role: candidate.role as EvidenceExcerptRole,
      sourceText,
      candidate: candidate.quote,
      visibleRanges,
    });
    if (excerpt) excerpts.push(excerpt);
    else rejectedCount++;
  }
  return { candidateCount: candidates.length, rejectedCount, excerpts };
}
