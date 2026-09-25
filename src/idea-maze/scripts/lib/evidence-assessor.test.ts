import { describe, expect, it, vi } from "vitest";
import {
  buildRequestBody,
  buildAssessmentCacheKey,
  estimateInputTokens,
  planAssessmentBatch,
  stableSerialize,
  validateCandidate,
  type EvidenceAssessmentCandidate,
} from "./evidence-assessor.ts";
import { createTypeSafeEvidenceAssessor } from "./evidence-assessor-typesafe.ts";

function candidate(overrides: Partial<EvidenceAssessmentCandidate> = {}): EvidenceAssessmentCandidate {
  return {
    candidateId: "source-17",
    state: {
      sourceTextHash: "source-version-hash",
      opportunityThesis: "Teams need help reconciling receipts.",
      verifiedExcerpts: [{ role: "pain", quote: "At the end, chasing every receipt wastes an hour." }],
      contextOnly: "Unverified context only: source-format details.",
    },
    rubricVersion: "idea-maze-jev-shadow-v1",
    questions: [
      {
        id: "tailquote_grounding",
        dimension: "tailquote",
        instructions: "Does a verified source excerpt directly support the opportunity thesis?",
        trueMeans: "The exact verified quote describes the claimed pain or workaround.",
        falseMeans: "The quote is missing, unrelated, or only implies the claim.",
      },
      {
        id: "contradiction_signal",
        dimension: "contradiction",
        instructions: "Does the source directly contradict the opportunity thesis?",
        trueMeans: "The source states that the proposed pain is absent or already solved.",
        falseMeans: "The source does not directly contradict the thesis.",
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("TypeSafe Jev shadow assessor", () => {
  it("is disabled by default and preserves candidates without making a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const assessor = createTypeSafeEvidenceAssessor({ env: {}, fetchImpl });
    const source = candidate();
    const [result] = await assessor.assessBatch([source]);

    expect(assessor.isEnabled()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      candidateId: source.candidateId,
      candidateState: source.state,
      mode: "shadow",
      appliedToDecision: false,
      status: "disabled",
      requestedModel: null,
      cacheHit: false,
    });
    expect(result.assessments).toEqual(source.questions.map((question) => ({
      id: question.id,
      dimension: question.dimension,
      status: "unknown",
      noul: null,
    })));
  });

  it("requires the explicit enable flag, API key, and account-selected model", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const noModel = createTypeSafeEvidenceAssessor({
      env: { IDEA_MAZE_JEV_ENABLED: "true", TYPESAFE_API_KEY: "test-key" },
      fetchImpl,
    });
    expect(noModel.isEnabled()).toBe(false);
    const [result] = await noModel.assessBatch([candidate()]);
    expect(result.reason).toBe("missing_explicit_model");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends named questions against verified quote plus context, records returned model and usage, and never applies a cutoff", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      model: "account-enabled-jev-version",
      answers: {
        tailquote_grounding: { type: "noul", noul: 0 },
        contradiction_signal: { type: "noul", noul: 0.25 },
      },
      usage: { input_tokens: 0, output_tokens: 8 },
    }));
    const assessor = createTypeSafeEvidenceAssessor({
      env: {
        IDEA_MAZE_JEV_ENABLED: "true",
        IDEA_MAZE_JEV_MODEL: "explicit-account-pin",
        TYPESAFE_API_KEY: "test-key",
      },
      fetchImpl,
    });
    const source = candidate();
    const [result] = await assessor.assessBatch([source]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));

    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-key");
    expect(body).toMatchObject({
      state: source.state,
      model: "explicit-account-pin",
      questions: {
        tailquote_grounding: {
          type: "noul",
          criteria: {
            true: "The exact verified quote describes the claimed pain or workaround.",
            false: "The quote is missing, unrelated, or only implies the claim.",
          },
        },
        contradiction_signal: { type: "noul" },
      },
    });
    expect(result).toMatchObject({
      status: "complete",
      requestedModel: "explicit-account-pin",
      returnedModel: "account-enabled-jev-version",
      usage: { inputTokens: 0, outputTokens: 8 },
      mode: "shadow",
      appliedToDecision: false,
    });
    expect(result.assessments.map((dimension) => dimension.dimension)).toEqual(["tailquote", "contradiction"]);
    expect(result.assessments[0]).toMatchObject({ status: "scored", noul: 0 });
    expect(result.candidateState).toEqual(source.state);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps malformed, missing, or out-of-range answers unknown instead of assigning zero", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      model: "jev-returned",
      answers: {
        tailquote_grounding: { type: "noul", noul: 1.2 },
        contradiction_signal: { type: "choice", choice: "yes" },
      },
    }));
    const assessor = createTypeSafeEvidenceAssessor({
      env: {
        IDEA_MAZE_JEV_ENABLED: "true",
        IDEA_MAZE_JEV_MODEL: "account-pin",
        TYPESAFE_API_KEY: "test-key",
      },
      fetchImpl,
    });
    const source = candidate();
    const [result] = await assessor.assessBatch([source]);
    expect(result.status).toBe("unknown");
    expect(result.assessments.every((answer) => answer.status === "unknown" && answer.noul === null)).toBe(true);
    expect(result.candidateState).toEqual(source.state);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it("preserves every candidate and returns sanitized retry hints on an HTTP failure without retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: "do not surface this body" }, 529));
    const assessor = createTypeSafeEvidenceAssessor({
      env: {
        IDEA_MAZE_JEV_ENABLED: "true",
        IDEA_MAZE_JEV_MODEL: "account-pin",
        TYPESAFE_API_KEY: "test-key",
      },
      fetchImpl,
    });
    const source = candidate();
    const [result] = await assessor.assessBatch([source]);
    expect(result).toMatchObject({
      status: "error",
      reason: "http_error",
      httpStatus: 529,
      retryable: true,
      candidateState: source.state,
      appliedToDecision: false,
    });
    expect(String(result.reason)).not.toContain("do not surface");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds total calls and conservative input-byte budget without truncating state", async () => {
    const first = candidate({ candidateId: "large", state: { sourceTextHash: "h1", excerpt: "a".repeat(100) } });
    const second = candidate({ candidateId: "small", state: { sourceTextHash: "h2", excerpt: "small" } });
    const estimated = estimateInputTokens(buildRequestBody(second, "jev"));
    expect(estimated).toBeGreaterThan(0);
    const planned = planAssessmentBatch({
      candidates: [first, second],
      requestedModel: "jev",
      budget: { maxCalls: 1, maxInputTokens: estimateInputTokens({
        state: first.state,
        model: "jev",
        questions: Object.fromEntries(first.questions.map((q) => [q.id, {
          type: "noul", instructions: q.instructions, criteria: { true: q.trueMeans, false: q.falseMeans },
        }])),
      }) },
    });
    expect(planned.map((entry) => entry.status)).toEqual(["ready", "skipped_budget"]);
    expect(planned[1].reason).toBe("call_limit");
    expect(planned[0].candidate.state).toEqual(first.state);
  });

  it("applies one total deadline through response JSON parsing and does not retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("slow body")), { once: true });
      }),
    } as Response));
    const assessor = createTypeSafeEvidenceAssessor({
      env: {
        IDEA_MAZE_JEV_ENABLED: "true",
        IDEA_MAZE_JEV_MODEL: "account-pin",
        TYPESAFE_API_KEY: "test-key",
      },
      fetchImpl,
    });
    const source = candidate();
    const results = await assessor.assessBatch([source, candidate({ candidateId: "second" })], {
      maxCalls: 2,
      maxInputTokens: 10_000,
      timeoutMs: 10,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({ status: "error", reason: "timeout", candidateState: source.state });
    expect(results[1]).toMatchObject({ status: "error", reason: "timeout", candidateId: "second" });
  });

  it("keys cache on full state/source version, named questions, rubric version, and requested model", () => {
    const base = candidate();
    const key = buildAssessmentCacheKey({
      state: base.state,
      questions: base.questions,
      rubricVersion: base.rubricVersion,
      requestedModel: "jev-a",
    });
    expect(buildAssessmentCacheKey({
      state: { ...base.state as object, sourceTextHash: "changed" },
      questions: base.questions,
      rubricVersion: base.rubricVersion,
      requestedModel: "jev-a",
    })).not.toBe(key);
    expect(buildAssessmentCacheKey({
      state: base.state,
      questions: base.questions,
      rubricVersion: "rubric-v2",
      requestedModel: "jev-a",
    })).not.toBe(key);
    expect(buildAssessmentCacheKey({
      state: base.state,
      questions: base.questions,
      rubricVersion: base.rubricVersion,
      requestedModel: "jev-b",
    })).not.toBe(key);
    expect(buildAssessmentCacheKey({
      state: {
        opportunityThesis: (base.state as Record<string, unknown>).opportunityThesis,
        sourceTextHash: (base.state as Record<string, unknown>).sourceTextHash,
        verifiedExcerpts: (base.state as Record<string, unknown>).verifiedExcerpts,
        contextOnly: (base.state as Record<string, unknown>).contextOnly,
      },
      questions: base.questions,
      rubricVersion: base.rubricVersion,
      requestedModel: "jev-a",
    })).toBe(key);
  });

  it("rejects non-JSON states that could collide with serialized request bodies", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const state of [null, 42, true, Number.NaN, Number.POSITIVE_INFINITY, undefined, new Date(), cycle]) {
      expect(() => validateCandidate(candidate({ state }))).toThrow();
    }
    expect(() => stableSerialize({ nested: undefined })).toThrow();
    expect(() => stableSerialize({ nested: Number.NaN })).toThrow();
  });
});
