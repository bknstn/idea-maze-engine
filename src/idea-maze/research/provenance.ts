import type { VerifiedExcerptV1 } from "./contracts.js";
import { verifyEvidenceExcerpt } from "../scripts/lib/evidence-excerpts.ts";

const RESEARCH_ROLES = new Set<VerifiedExcerptV1["role"]>([
  "pain",
  "workaround",
  "wtp",
  "time_loss",
  "claim",
]);
const EXCERPT_KEYS = new Set([
  "version",
  "sourceItemId",
  "role",
  "quote",
  "sourceTextHash",
  "startUtf16",
  "endUtf16",
]);

/**
 * Verify a hypothesis-research excerpt against its complete persisted original.
 * The legacy excerpt verifier intentionally knows only its four historical
 * roles. For the research-only `claim` role, this adapter supplies a temporary
 * legacy role solely to reuse its exact hash/range/quote checks, then returns
 * the original `claim` label unchanged. No legacy pain label is stored or
 * exposed for a generic technical or market claim.
 */
export function verifyResearchExcerpt(input: {
  sourceItemId: number;
  sourceText: string;
  excerpt: unknown;
}): VerifiedExcerptV1 | null {
  if (!Number.isSafeInteger(input.sourceItemId) || input.sourceItemId < 1) return null;
  if (typeof input.sourceText !== "string") return null;
  if (!input.excerpt || typeof input.excerpt !== "object" || Array.isArray(input.excerpt)) return null;

  const value = input.excerpt as Record<string, unknown>;
  if (Object.keys(value).some((key) => !EXCERPT_KEYS.has(key)) ||
      Object.keys(value).length !== EXCERPT_KEYS.size ||
      value.version !== 1 || value.sourceItemId !== input.sourceItemId ||
      typeof value.role !== "string" || !RESEARCH_ROLES.has(value.role as VerifiedExcerptV1["role"]) ||
      typeof value.quote !== "string" || value.quote.length < 1 || value.quote.length > 800 ||
      typeof value.sourceTextHash !== "string" ||
      !Number.isSafeInteger(value.startUtf16) || !Number.isSafeInteger(value.endUtf16)) {
    return null;
  }

  const role = value.role as VerifiedExcerptV1["role"];
  const legacyRole = role === "claim" ? "pain" : role;
  const grounded = verifyEvidenceExcerpt({
    sourceItemId: input.sourceItemId,
    sourceText: input.sourceText,
    excerpt: { ...value, role: legacyRole },
  });
  return grounded ? { ...grounded, role } : null;
}
