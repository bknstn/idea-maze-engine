import type Database from 'better-sqlite3';
import { normalizeEvidenceText } from './evidence-quality.ts';

export type DuplicateAction = 'archive_duplicate_rejected' | 'attach_to_active' | 'attach_to_approved';
export interface DuplicateGateResult {
  duplicate: boolean;
  matchedOpportunityId?: number;
  matchedSlug?: string;
  matchedLifecycleStage?: string;
  action?: DuplicateAction;
  reasons: string[];
  similarity: number;
  sharedSourceIds: number[];
}
const STOP_WORDS = new Set(['a','an','and','app','for','in','is','it','my','of','on','or','our','the','this','to','tool','with','people','out']);
interface OpportunityRow { cluster_key: string; id: number; slug: string; thesis: string; title: string; lifecycle_stage: string; status: string; created_at_utc: string }
function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)));
}
function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 0;
  let intersection = 0; for (const token of left) if (right.has(token)) intersection++;
  return intersection / new Set([...left, ...right]).size;
}
function slugFamily(slug: string): string { return [...tokens(slug)].slice(0, 2).join('-'); }
function opportunityTokens(input: { cluster_key: string; slug: string; thesis: string; title: string }): Set<string> {
  return tokens(`${input.title} ${input.slug} ${input.cluster_key} ${input.thesis}`);
}
interface SourceIdentity { id: number; signature: string }
function getSources(db: Database.Database, opportunityId: number): SourceIdentity[] {
  return (db.prepare(`SELECT si.id, si.title, si.text FROM source_items si JOIN opportunity_sources os ON os.source_item_id=si.id WHERE os.opportunity_id=?`).all(opportunityId) as Array<{id:number;title:string|null;text:string}>).map((row) => ({ id: row.id, signature: normalizeEvidenceText(`${row.title ?? ''} ${row.text}`) }));
}
function actionFor(stage: string): DuplicateAction {
  if (stage === 'rejected') return 'archive_duplicate_rejected';
  if (stage === 'approved') return 'attach_to_approved';
  return 'attach_to_active';
}
function canonicalRank(stage: string): number {
  if (stage === 'approved') return 0;
  if (stage === 'rejected') return 2;
  return 1;
}

export function findOpportunityDuplicate(db: Database.Database, candidate: { id:number;slug:string;title:string;thesis:string;cluster_key:string }): DuplicateGateResult {
  const candidateRow = db.prepare(
    'SELECT lifecycle_stage, created_at_utc FROM opportunities WHERE id = ?',
  ).get(candidate.id) as { lifecycle_stage: string; created_at_utc: string } | undefined;
  const cohort = db.prepare(`SELECT id,slug,title,thesis,cluster_key,lifecycle_stage,status,created_at_utc FROM opportunities WHERE id != ? AND (lifecycle_stage IN ('rejected','review_gate','approved') OR (status='active' AND lifecycle_stage IN ('scored','shortlisted','researching','artifact'))) ORDER BY CASE WHEN lifecycle_stage='approved' THEN 0 WHEN lifecycle_stage='rejected' THEN 2 ELSE 1 END, created_at_utc ASC, id ASC`).all(candidate.id) as OpportunityRow[];
  const candidateTokens = opportunityTokens(candidate);
  const candidateSources = getSources(db, candidate.id);
  const ids = new Set(candidateSources.map((source) => source.id));
  const signatures = new Set(candidateSources.map((source) => source.signature));
  const family = slugFamily(candidate.slug);
  let best: DuplicateGateResult = { duplicate:false,reasons:[],sharedSourceIds:[],similarity:0 };
  let bestRank = Number.POSITIVE_INFINITY;
  for (const other of cohort) {
    if (candidateRow && canonicalRank(other.lifecycle_stage) === canonicalRank(candidateRow.lifecycle_stage)) {
      const otherIsNewer = other.created_at_utc > candidateRow.created_at_utc ||
        (other.created_at_utc === candidateRow.created_at_utc && other.id > candidate.id);
      if (otherIsNewer) continue;
    }
    const otherSources = getSources(db, other.id);
    const sharedSourceIds = otherSources.filter((source) => ids.has(source.id)).map((source) => source.id);
    const sharedSignature = otherSources.some((source) => signatures.has(source.signature));
    const similarity = jaccard(candidateTokens, opportunityTokens(other));
    const sameCluster = normalizeEvidenceText(candidate.cluster_key) === normalizeEvidenceText(other.cluster_key);
    const reasons: string[] = [];
    if (sharedSourceIds.length) reasons.push(other.lifecycle_stage === 'rejected' ? 'shared_rejected_source' : 'shared_source');
    if (sharedSignature) reasons.push('shared_source_signature');
    if (similarity > 0.55) reasons.push(other.lifecycle_stage === 'rejected' ? 'similar_to_rejected' : 'same_thesis');
    if (family && family === slugFamily(other.slug)) reasons.push('same_slug_family');
    if (sameCluster && similarity > 0.2) reasons.push('same_cluster_thesis');
    const duplicate = sharedSignature || (sharedSourceIds.length > 0 && similarity > 0.25) || similarity > 0.55 || reasons.includes('same_slug_family') || reasons.includes('same_cluster_thesis');
    const rank = canonicalRank(other.lifecycle_stage);
    if (duplicate && rank < bestRank) {
      bestRank = rank;
      best = { duplicate:true, matchedOpportunityId:other.id, matchedSlug:other.slug, matchedLifecycleStage:other.lifecycle_stage, action:actionFor(other.lifecycle_stage), reasons, similarity, sharedSourceIds };
    }
  }
  return best;
}

/** Backwards-compatible name; now checks the complete relevant cohort. */
export const findRejectedDuplicate = findOpportunityDuplicate;

export function attachDuplicateEvidence(db: Database.Database, duplicateId: number, canonicalId: number): number {
  const result = db.prepare(`INSERT OR IGNORE INTO opportunity_sources (opportunity_id,source_item_id) SELECT ?,source_item_id FROM opportunity_sources WHERE opportunity_id=?`).run(canonicalId, duplicateId);
  return result.changes;
}
