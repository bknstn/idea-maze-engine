import { createHash } from "node:crypto";

import type {
  SourceVersionReference,
  VerifiedEvidenceLink,
  VerifiedExcerptV1,
  WorkspaceRunLease,
} from "./contracts.js";
import type { ResearchRepositories, SourceVersionRecord } from "./repositories.js";
import { RepositoryNotFoundError, StaleWorkspaceLeaseError } from "./repositories.js";
import { verifyResearchExcerpt } from "./provenance.js";

const MAX_CANDIDATES = 500;
const MAX_INTERPRETATION_CHARS = 2_000;
const CANDIDATE_KEYS = new Set(["kind", "hypothesisId", "relationship", "source", "excerpt", "interpretation"]);
const SOURCE_KEYS = new Set(["sourceId", "canonicalUrl", "retrievedAt"]);
const EXCERPT_KEYS = new Set(["version", "sourceItemId", "role", "quote", "sourceTextHash", "startUtf16", "endUtf16"]);
const RELATIONSHIPS = new Set(["supports", "contradicts", "context"]);
const EXCERPT_ROLES = new Set(["pain", "workaround", "wtp", "time_loss", "claim"]);

/**
 * Input classifications are untrusted data. The mapper only accepts complete
 * excerpts that can be re-verified against a source version already persisted
 * by the original-source step. Search snippets are never candidates for proof.
 */
export interface EvidenceExcerptCandidate {
  kind: "verified_excerpt_candidate";
  hypothesisId: string;
  relationship: VerifiedEvidenceLink["relationship"];
  source: SourceVersionReference;
  excerpt: VerifiedExcerptV1;
  interpretation: string;
}

export type EvidenceRejectionReason =
  | "invalid_shape"
  | "snippet_not_proof"
  | "hypothesis_not_active"
  | "source_not_persisted"
  | "source_mismatch"
  | "excerpt_unverified"
  | "duplicate";

export interface EvidenceCandidateRejection {
  candidateIndex: number;
  reason: EvidenceRejectionReason;
}

export interface EvidenceIndependenceGroup {
  groupId: string;
  sourceIds: string[];
  evidenceIds: string[];
  /** Author-level independence is not available from source IDs/URLs alone. */
  independenceUncertain: true;
}

export interface EvidenceIndependenceReport {
  groups: EvidenceIndependenceGroup[];
  /** Distinct dependency groups; this does not assert independent authorship. */
  sourceGroupCount: number;
  /** Null because source IDs and URLs cannot establish independent authors. */
  confirmedIndependentCount: null;
  independenceUncertain: true;
}

export interface EvidenceMappingResult {
  runId: string;
  accepted: VerifiedEvidenceLink[];
  rejected: EvidenceCandidateRejection[];
  independence: EvidenceIndependenceReport;
}

export interface EvidenceSourceIdentity {
  evidenceId: string;
  source: SourceVersionReference;
  sourceText?: string;
}

/**
 * Build a fresh dependency report instead of trusting immutable link labels.
 * Same source-item IDs, normalized canonical URLs, and sufficiently substantial
 * normalized copies are merged. New evidence can connect previous groups, so
 * callers should recompute this report over the complete run evidence set.
 */
export function groupEvidenceSources(sources: readonly EvidenceSourceIdentity[]): EvidenceIndependenceReport {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const current = parent.get(key);
    if (!current) {
      parent.set(key, key);
      return key;
    }
    if (current === key) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  };
  const nodeForSource = (sourceId: string): string => {
    const id = sourceItemIdFromSourceId(sourceId);
    const node = `source:${id}`;
    find(node);
    return node;
  };
  const urlOwners = new Map<string, string>();
  const copyOwners = new Map<string, string>();
  const nodes = sources.map((item) => ({ item, node: nodeForSource(item.source.sourceId) }));

  for (const { item, node } of nodes) {
    const canonical = normalizeCanonicalUrl(item.source.canonicalUrl);
    if (canonical) {
      const prior = urlOwners.get(canonical);
      if (prior) union(node, prior);
      else urlOwners.set(canonical, node);
    }
    if (typeof item.sourceText === "string") {
      const copyHash = normalizedCopyHash(item.sourceText);
      if (copyHash) {
        const prior = copyOwners.get(copyHash);
        if (prior) union(node, prior);
        else copyOwners.set(copyHash, node);
      }
    }
  }

  const byRoot = new Map<string, { sourceIds: Set<string>; evidenceIds: Set<string> }>();
  for (const { item, node } of nodes) {
    const root = find(node);
    let group = byRoot.get(root);
    if (!group) {
      group = { sourceIds: new Set(), evidenceIds: new Set() };
      byRoot.set(root, group);
    }
    group.sourceIds.add(item.source.sourceId);
    group.evidenceIds.add(item.evidenceId);
  }

  const groups = Array.from(byRoot.values(), (group) => {
    const sourceIds = [...group.sourceIds].sort();
    const evidenceIds = [...group.evidenceIds].sort();
    const stableKey = sourceIds.join("\n");
    return {
      groupId: `independence:${sha256(stableKey).slice(0, 24)}`,
      sourceIds,
      evidenceIds,
      independenceUncertain: true as const,
    };
  }).sort((left, right) => left.groupId.localeCompare(right.groupId));

  return {
    groups,
    sourceGroupCount: groups.length,
    confirmedIndependentCount: null,
    independenceUncertain: true,
  };
}

/**
 * Validate and persist caller/model classifications for one immutable run.
 * This function makes no model/provider calls; source bodies are only read as
 * inert text for provenance and duplicate grouping.
 */
export function mapEvidenceToHypotheses(input: {
  repositories: ResearchRepositories;
  runId: string;
  lease: WorkspaceRunLease;
  candidates: readonly unknown[];
}): EvidenceMappingResult {
  if (!Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES) {
    throw new RangeError(`candidates must contain at most ${MAX_CANDIDATES} entries`);
  }
  if (input.lease.runId !== input.runId) throw new StaleWorkspaceLeaseError();
  input.repositories.leases.assertCurrent(input.lease);
  const run = input.repositories.runs.get(input.runId);
  if (!run) throw new RepositoryNotFoundError("run", input.runId);

  const activeHypotheses = new Set(run.snapshot.caseRevision.hypothesisRevisions
    .filter((hypothesis) => hypothesis.state === "active")
    .map((hypothesis) => hypothesis.hypothesisId));
  const rejected: EvidenceCandidateRejection[] = [];
  const pending: PendingEvidence[] = [];

  input.candidates.forEach((raw, candidateIndex) => {
    if (isRecord(raw) && raw.kind === "search_snippet") {
      rejected.push({ candidateIndex, reason: "snippet_not_proof" });
      return;
    }
    const candidate = parseCandidate(raw);
    if (!candidate) {
      rejected.push({ candidateIndex, reason: "invalid_shape" });
      return;
    }
    if (!activeHypotheses.has(candidate.hypothesisId)) {
      rejected.push({ candidateIndex, reason: "hypothesis_not_active" });
      return;
    }

    let version: SourceVersionRecord | null = null;
    try {
      version = input.repositories.sources.getVersion({
        sourceItemId: candidate.excerpt.sourceItemId,
        sourceTextHash: candidate.excerpt.sourceTextHash,
        retrievedAt: candidate.source.retrievedAt,
      });
    } catch {
      version = null;
    }
    if (!version) {
      rejected.push({ candidateIndex, reason: "source_not_persisted" });
      return;
    }
    if (version.workspaceKey !== input.repositories.workspaceKey ||
        version.sourceItemId !== candidate.excerpt.sourceItemId ||
        version.sourceTextHash !== candidate.excerpt.sourceTextHash ||
        version.retrievedAt !== candidate.source.retrievedAt ||
        version.canonicalUrl !== candidate.source.canonicalUrl ||
        sourceItemIdFromSourceId(candidate.source.sourceId) !== candidate.excerpt.sourceItemId) {
      rejected.push({ candidateIndex, reason: "source_mismatch" });
      return;
    }
    const excerpt = verifyResearchExcerpt({
      sourceItemId: version.sourceItemId,
      sourceText: version.sourceText,
      excerpt: candidate.excerpt,
    });
    if (!excerpt) {
      rejected.push({ candidateIndex, reason: "excerpt_unverified" });
      return;
    }

    pending.push({
      candidateIndex,
      sourceText: version.sourceText,
      link: {
        kind: "verified_excerpt",
        evidenceId: evidenceIdFor(candidate),
        hypothesisId: candidate.hypothesisId,
        relationship: candidate.relationship,
        source: candidate.source,
        excerpt,
        verification: "matched_to_fetched_original",
        interpretation: candidate.interpretation,
        independenceGroupId: "pending",
        independenceUncertain: true,
      },
    });
  });

  const existing = input.repositories.evidence.list(input.runId)
    .filter((evidence): evidence is VerifiedEvidenceLink => evidence.kind === "verified_excerpt");
  const existingKeys = new Set(existing.map(evidenceDeduplicationKey));
  const acceptedPending: PendingEvidence[] = [];
  for (const item of pending) {
    const key = evidenceDeduplicationKey(item.link);
    if (existingKeys.has(key)) {
      rejected.push({ candidateIndex: item.candidateIndex, reason: "duplicate" });
      continue;
    }
    existingKeys.add(key);
    acceptedPending.push(item);
  }

  const groupSources = [
    ...existing.map((link) => sourceIdentityFor(input.repositories, link)),
    ...acceptedPending.map(({ link, sourceText }) => ({ evidenceId: link.evidenceId, source: link.source, sourceText })),
  ];
  const independence = groupEvidenceSources(groupSources);
  const groupForEvidence = new Map<string, EvidenceIndependenceGroup>();
  for (const group of independence.groups) {
    for (const evidenceId of group.evidenceIds) groupForEvidence.set(evidenceId, group);
  }

  const accepted: VerifiedEvidenceLink[] = [];
  input.repositories.leases.withWrite(input.lease, () => {
    for (const item of acceptedPending) {
      const group = groupForEvidence.get(item.link.evidenceId);
      const link = {
        ...item.link,
        independenceGroupId: group?.groupId ?? item.link.independenceGroupId,
        independenceUncertain: true,
      } satisfies VerifiedEvidenceLink;
      accepted.push(input.repositories.evidence.save(input.runId, link, input.lease) as VerifiedEvidenceLink);
    }
  });

  // Read back immutable rows and recompute in case the run already held evidence
  // or another follow-up link connected formerly separate source groups.
  const persisted = input.repositories.evidence.list(input.runId)
    .filter((evidence): evidence is VerifiedEvidenceLink => evidence.kind === "verified_excerpt");
  return {
    runId: input.runId,
    accepted,
    rejected: rejected.sort((left, right) => left.candidateIndex - right.candidateIndex),
    independence: groupEvidenceSources(persisted.map((link) => sourceIdentityFor(input.repositories, link))),
  };
}

interface ParsedCandidate extends EvidenceExcerptCandidate {}
interface PendingEvidence {
  candidateIndex: number;
  link: VerifiedEvidenceLink;
  sourceText: string;
}

function parseCandidate(value: unknown): ParsedCandidate | null {
  if (!isRecord(value) || !hasOnlyKeys(value, CANDIDATE_KEYS) ||
      value.kind !== "verified_excerpt_candidate" ||
      typeof value.hypothesisId !== "string" || !isBoundedText(value.hypothesisId, 1, 128) ||
      typeof value.relationship !== "string" || !RELATIONSHIPS.has(value.relationship) ||
      !isRecord(value.source) || !hasOnlyKeys(value.source, SOURCE_KEYS) || Object.keys(value.source).length !== SOURCE_KEYS.size ||
      typeof value.source.sourceId !== "string" || !/^source_items:[1-9]\d{0,14}$/.test(value.source.sourceId) ||
      typeof value.source.canonicalUrl !== "string" || !isBoundedText(value.source.canonicalUrl, 1, 2048) ||
      typeof value.source.retrievedAt !== "string" || !isCanonicalIso(value.source.retrievedAt) ||
      typeof value.interpretation !== "string" || !isBoundedText(value.interpretation, 1, MAX_INTERPRETATION_CHARS) ||
      !isRecord(value.excerpt) || !hasOnlyKeys(value.excerpt, EXCERPT_KEYS) || Object.keys(value.excerpt).length !== EXCERPT_KEYS.size) return null;
  const excerpt = value.excerpt as unknown as VerifiedExcerptV1;
  if (excerpt.version !== 1 || !Number.isSafeInteger(excerpt.sourceItemId) || excerpt.sourceItemId < 1 ||
      !EXCERPT_ROLES.has(excerpt.role) || typeof excerpt.quote !== "string" ||
      excerpt.quote.length < 1 || excerpt.quote.length > 800 ||
      typeof excerpt.sourceTextHash !== "string" || !/^[a-f0-9]{64}$/i.test(excerpt.sourceTextHash) ||
      !Number.isSafeInteger(excerpt.startUtf16) || !Number.isSafeInteger(excerpt.endUtf16) ||
      sourceItemIdFromSourceId(value.source.sourceId) !== excerpt.sourceItemId) return null;
  return value as unknown as ParsedCandidate;
}

function sourceIdentityFor(repositories: ResearchRepositories, link: VerifiedEvidenceLink): EvidenceSourceIdentity {
  const sourceItemId = sourceItemIdFromSourceId(link.source.sourceId);
  const version = repositories.sources.getVersion({
    sourceItemId,
    sourceTextHash: link.excerpt.sourceTextHash,
    retrievedAt: link.source.retrievedAt,
  });
  return {
    evidenceId: link.evidenceId,
    source: link.source,
    ...(version ? { sourceText: version.sourceText } : {}),
  };
}

function evidenceDeduplicationKey(link: VerifiedEvidenceLink): string {
  return JSON.stringify([
    link.source.sourceId,
    normalizeCanonicalUrl(link.source.canonicalUrl) ?? link.source.canonicalUrl,
    link.excerpt.sourceTextHash,
    link.source.retrievedAt,
    link.excerpt.startUtf16,
    link.excerpt.endUtf16,
    link.excerpt.quote,
    link.hypothesisId,
    link.relationship,
  ]);
}

function evidenceIdFor(candidate: ParsedCandidate): string {
  const value = [
    candidate.source.sourceId,
    candidate.source.canonicalUrl,
    candidate.source.retrievedAt,
    candidate.excerpt.sourceTextHash,
    candidate.excerpt.startUtf16,
    candidate.excerpt.endUtf16,
    candidate.hypothesisId,
    candidate.relationship,
  ].join("\n");
  return `evidence_${sha256(value).slice(0, 40)}`;
}

function sourceItemIdFromSourceId(sourceId: string): number {
  const match = /^source_items:([1-9]\d{0,14})$/.exec(sourceId);
  if (!match) return Number.NaN;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : Number.NaN;
}

function normalizeCanonicalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_[a-z0-9_]+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedCopyHash(text: string): string | null {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
  const substantiveLength = (normalized.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (substantiveLength < 48) return null;
  return sha256(normalized);
}

function isCanonicalIso(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isBoundedText(value: string, minimum: number, maximum: number): boolean {
  return value.trim().length >= minimum && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
