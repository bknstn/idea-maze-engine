import { createHash } from "node:crypto";

import {
  success,
  type CoverageGap,
  type ResearchAssessment,
  type ResearchEvidence,
  type ResearchResultPage,
  type ResultInput,
} from "./contracts.js";
import { RepositoryNotFoundError, type ResearchRepositories } from "./repositories.js";

/** Conservative ceiling for the duplicated MCP text and structured forms. */
export const MAX_RESEARCH_RESULT_BYTES = 448 * 1024;
const MAX_MARKDOWN_CHARACTERS = 30_000;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const CURSOR_PREFIX = "r1.";

interface CursorPayload {
  runId: string;
  offset: number;
  pageSize: number;
  contentDigest: string;
}

export class InvalidResearchResultCursorError extends Error {
  constructor(readonly reason: "invalid" | "stale") {
    super(reason === "stale"
      ? "The result changed after this cursor was issued; request a new first page."
      : "The research result cursor is invalid for this run.");
    this.name = "InvalidResearchResultCursorError";
  }
}

export class ResearchResultTooLargeError extends Error {
  constructor() {
    super("The research result exceeds a supported response bound.");
    this.name = "ResearchResultTooLargeError";
  }
}

export interface ResearchResultService {
  /** Read-only; returns one byte-bounded page from the bound repositories. */
  result(input: ResultInput): ResearchResultPage;
}

/**
 * Bind result reads to the application's existing repository set. The service
 * performs no writes, provider calls, file access, or caller-selected path I/O.
 */
export function createResearchResultService(repositories: ResearchRepositories): ResearchResultService {
  return Object.freeze({
    result(input: ResultInput): ResearchResultPage {
      const run = repositories.runs.get(input.runId);
      if (!run) throw new RepositoryNotFoundError("run", input.runId);
      const evidence = repositories.evidence.list(input.runId);
      const assessment = repositories.assessments.get(input.runId) ?? run.assessment;
      const coverageGaps = run.coverageGaps;
      assertResultSchemaBounds(run.runId, assessment, evidence, coverageGaps);
      const contentDigest = digestContent({ runId: run.runId, assessment, evidence, coverageGaps });
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);

      let offset = 0;
      let pageSize = boundedPageSize(input.limit);
      if (cursor) {
        if (cursor.runId !== run.runId) throw new InvalidResearchResultCursorError("invalid");
        if (cursor.contentDigest !== contentDigest) throw new InvalidResearchResultCursorError("stale");
        if (input.limit !== undefined && input.limit !== cursor.pageSize) throw new InvalidResearchResultCursorError("invalid");
        if (cursor.offset >= evidence.length || cursor.offset < 1) throw new InvalidResearchResultCursorError("invalid");
        offset = cursor.offset;
        pageSize = cursor.pageSize;
      }

      const maximumCount = Math.min(pageSize, evidence.length - offset);
      for (let count = maximumCount; count >= 0; count -= 1) {
        const pageEvidence = evidence.slice(offset, offset + count);
        const hasMore = offset + count < evidence.length;
        const nextCursor = hasMore
          ? encodeCursor({ runId: run.runId, offset: offset + count, pageSize, contentDigest })
          : null;
        const markdown = input.format === "markdown"
          ? renderResearchResultMarkdown({ assessment, evidence: pageEvidence, coverageGaps })
          : null;
        const page: ResearchResultPage = {
          runId: run.runId,
          assessment,
          evidence: pageEvidence,
          coverageGaps,
          pagination: { nextCursor, hasMore, totalEvidence: evidence.length },
          reportMarkdown: markdown,
        };

        if (markdown !== null && markdown.length > MAX_MARKDOWN_CHARACTERS) continue;
        if (measureMcpResearchResultBytes(page) <= MAX_RESEARCH_RESULT_BYTES) {
          if (count === 0 && hasMore) throw new ResearchResultTooLargeError();
          return page;
        }
      }

      // Never silently drop a repeated assessment/gap or an evidence item that
      // cannot fit alongside it. The caller receives a bounded safe failure.
      throw new ResearchResultTooLargeError();
    },
  });
}

/** Render Markdown from exactly the same assessment, gaps, and evidence page. */
export function renderResearchResultMarkdown(input: {
  assessment: ResearchAssessment | null;
  evidence: readonly ResearchEvidence[];
  coverageGaps: readonly CoverageGap[];
}): string {
  const lines = ["# Research result", ""];
  if (!input.assessment) {
    lines.push("Assessment is not available yet.", "");
  } else {
    const assessment = input.assessment;
    lines.push("## Assessment", "", `**Outcome:** ${assessment.outcome}`, "", escapeMarkdown(assessment.summary), "", "### Rationale", "", escapeMarkdown(assessment.rationale), "", "### Claims", "");
    if (assessment.claims.length === 0) lines.push("No active claims were assessed.", "");
    for (const claim of assessment.claims) {
      lines.push(
        `- **${escapeMarkdown(claim.hypothesisId)}** — ${claim.outcome}: ${escapeMarkdown(claim.rationale)}`,
        `  - Supporting evidence IDs: ${formatIds(claim.supportingEvidenceIds)}`,
        `  - Challenging evidence IDs: ${formatIds(claim.challengingEvidenceIds)}`,
      );
      for (const missing of claim.missingEvidence) lines.push(`  - Missing evidence: ${escapeMarkdown(missing)}`);
    }
    lines.push("", "### Next experiment", "", escapeMarkdown(assessment.nextExperiment), "");
  }

  lines.push("## Coverage gaps", "");
  if (input.coverageGaps.length === 0) {
    lines.push("No coverage gaps were recorded.", "");
  } else {
    for (const gap of input.coverageGaps) {
      const scope = [gap.queryId ? `query ${gap.queryId}` : null, gap.hypothesisId ? `claim ${gap.hypothesisId}` : null]
        .filter((value): value is string => value !== null).join(", ");
      lines.push(`- **${gap.reason}**${scope ? ` (${escapeMarkdown(scope)})` : ""}: ${escapeMarkdown(gap.detail)}`);
    }
    lines.push("");
  }

  lines.push("## Evidence on this page", "");
  if (input.evidence.length === 0) lines.push("No evidence items are on this page.", "");
  for (const item of input.evidence) {
    if (item.kind === "verified_excerpt") {
      lines.push(
        `### Verified excerpt ${escapeMarkdown(item.evidenceId)}`,
        "",
        `- Claim: ${escapeMarkdown(item.hypothesisId)}`,
        `- Relationship: ${item.relationship}`,
        `- Source: ${escapeMarkdown(item.source.sourceId)} (${escapeMarkdown(item.source.canonicalUrl)})`,
        `- Retrieved: ${escapeMarkdown(item.source.retrievedAt)}`,
        "",
        "> Quoted text:",
        ...blockquote(item.excerpt.quote),
        "",
        `**Recorded interpretation:** ${escapeMarkdown(item.interpretation)}`,
        "",
      );
    } else {
      lines.push(
        `### Discovery snippet ${escapeMarkdown(item.snippetId)} (not assessment evidence)`,
        "",
        `- Query: ${escapeMarkdown(item.queryId)}`,
        `- Source URL: ${escapeMarkdown(item.sourceUrl)}`,
        "",
        ...blockquote(item.text),
        "",
        "This snippet is a retrieval lead only. It does not support or challenge a claim.",
        "",
      );
    }
  }
  return lines.join("\n").trim();
}

/** Count the exact duplicated JSON representations used by the MCP adapter. */
export function measureMcpResearchResultBytes(page: ResearchResultPage): number {
  const response = success(page);
  const encodedResponse = JSON.stringify(response);
  const encodedToolResult = JSON.stringify({
    content: [{ type: "text", text: encodedResponse }],
    structuredContent: JSON.parse(encodedResponse) as unknown,
  });
  return Buffer.byteLength(encodedToolResult, "utf8");
}

function assertResultSchemaBounds(
  runId: string,
  assessment: ResearchAssessment | null,
  evidence: readonly ResearchEvidence[],
  coverageGaps: readonly CoverageGap[],
): void {
  const validId = (value: string) => value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
  const validUri = (value: string) => {
    try { new URL(value); return true; } catch { return false; }
  };
  const validGap = (gap: CoverageGap) => COVERAGE_GAP_REASONS.has(gap.reason) && gap.detail.length > 0 && gap.detail.length <= 1_000 &&
    (gap.queryId === null || validId(gap.queryId)) &&
    (gap.hypothesisId === null || validId(gap.hypothesisId));
  if (!validId(runId) || coverageGaps.length > 1_000 || coverageGaps.some((gap) => !validGap(gap))) {
    throw new ResearchResultTooLargeError();
  }
  for (const item of evidence) {
    if (item.kind === "search_snippet") {
      if (!validId(item.snippetId) || !validId(item.queryId) || item.sourceUrl.length > 2_048 || !validUri(item.sourceUrl) || item.text.length < 1 || item.text.length > 2_000) {
        throw new ResearchResultTooLargeError();
      }
    } else if (!validId(item.evidenceId) || !validId(item.hypothesisId) || !validId(item.source.sourceId) ||
        item.source.canonicalUrl.length > 2_048 || !validUri(item.source.canonicalUrl) || item.excerpt.quote.length < 1 || item.excerpt.quote.length > 800 ||
        item.interpretation.length < 1 || item.interpretation.length > 2_000) {
      throw new ResearchResultTooLargeError();
    }
  }
  if (!assessment) return;
  if (assessment.summary.length < 1 || assessment.summary.length > 2_000 ||
      assessment.rationale.length < 1 || assessment.rationale.length > 4_000 ||
      assessment.nextExperiment.length < 1 || assessment.nextExperiment.length > 2_000 ||
      assessment.claims.length > 20 || assessment.coverageGaps.length > 1_000 ||
      assessment.coverageGaps.some((gap) => !validGap(gap))) {
    throw new ResearchResultTooLargeError();
  }
  for (const claim of assessment.claims) {
    if (!validId(claim.hypothesisId) || claim.rationale.length < 1 || claim.rationale.length > 2_000 ||
        claim.supportingEvidenceIds.length > 1_000 || claim.challengingEvidenceIds.length > 1_000 ||
        claim.supportingEvidenceIds.some((id) => !validId(id)) || claim.challengingEvidenceIds.some((id) => !validId(id)) ||
        claim.missingEvidence.length > 100 || claim.missingEvidence.some((item) => item.length < 1 || item.length > 500)) {
      throw new ResearchResultTooLargeError();
    }
  }
}

function boundedPageSize(value: number | undefined): number {
  const size = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
    throw new RangeError("Research result page size is outside the supported range.");
  }
  return size;
}

function encodeCursor(payload: CursorPayload): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decodeCursor(value: string): CursorPayload {
  if (typeof value !== "string" || value.length > 512 || !value.startsWith(CURSOR_PREFIX)) {
    throw new InvalidResearchResultCursorError("invalid");
  }
  try {
    const encodedPayload = value.slice(CURSOR_PREFIX.length);
    const text = Buffer.from(encodedPayload, "base64url").toString("utf8");
    const raw = JSON.parse(text) as unknown;
    if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== "contentDigest,offset,pageSize,runId" ||
        typeof raw.runId !== "string" || raw.runId.length < 1 || raw.runId.length > 160 ||
        !Number.isSafeInteger(raw.offset) || (raw.offset as number) < 1 ||
        !Number.isSafeInteger(raw.pageSize) || (raw.pageSize as number) < 1 || (raw.pageSize as number) > MAX_PAGE_SIZE ||
        typeof raw.contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(raw.contentDigest)) {
      throw new InvalidResearchResultCursorError("invalid");
    }
    const payload = raw as unknown as CursorPayload;
    if (encodeCursor(payload) !== value) throw new InvalidResearchResultCursorError("invalid");
    return payload;
  } catch (error) {
    if (error instanceof InvalidResearchResultCursorError) throw error;
    throw new InvalidResearchResultCursorError("invalid");
  }
}

function digestContent(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function formatIds(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map(escapeMarkdown).join(", ");
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+.!|>~-]/g, "\\$&")
    .replace(/\r?\n/g, " ");
}

function blockquote(value: string): string[] {
  return value.split(/\r?\n/).map((line) => `> ${escapeMarkdown(line)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const COVERAGE_GAP_REASONS = new Set<CoverageGap["reason"]>([
  "provider_unavailable", "no_results", "original_unavailable", "source_access_blocked", "search_failed",
  "fetch_failed", "budget_exhausted", "time_limit", "cancelled", "interrupted", "no_independent_sources",
]);
