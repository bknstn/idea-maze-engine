import {
  buildRequestBody,
  planAssessmentBatch,
  validateAssessmentBudget,
  validateCandidate,
  type DimensionAssessment,
  type EvidenceAssessor,
  type EvidenceAssessmentBudget,
  type EvidenceAssessmentCandidate,
  type EvidenceAssessmentOutcome,
} from "./evidence-assessor.ts";

const TYPESAFE_SYSTEMONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_TIMEOUT_MS = 120_000;

interface TypeSafeAnswer {
  type?: unknown;
  noul?: unknown;
}

interface TypeSafePayload {
  model?: unknown;
  answers?: Record<string, TypeSafeAnswer> | null;
  usage?: { input_tokens?: unknown; output_tokens?: unknown } | null;
}

export function createTypeSafeEvidenceAssessor(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
} = {}): EvidenceAssessor {
  const env = options.env ?? process.env;
  const apiKey = env.TYPESAFE_API_KEY?.trim() ?? "";
  const requestedModel = env.IDEA_MAZE_JEV_MODEL?.trim() ?? "";
  const enabledByFlag = env.IDEA_MAZE_JEV_ENABLED?.trim().toLowerCase() === "true";
  const fetchImpl = options.fetchImpl ?? fetch;

  const isEnabled = () => enabledByFlag && apiKey.length > 0 && requestedModel.length > 0;

  return {
    name: "typesafe-jev",
    isEnabled,
    requestedModel: () => requestedModel || null,
    async assessBatch(
      candidates: EvidenceAssessmentCandidate[],
      budgetInput: EvidenceAssessmentBudget = {},
    ): Promise<EvidenceAssessmentOutcome[]> {
      const budget = validateAssessmentBudget(budgetInput);
      if (!isEnabled()) {
        const reason = !enabledByFlag
          ? "disabled_by_default_or_flag"
          : !apiKey ? "missing_api_key" : "missing_explicit_model";
        return candidates.map((candidate) => outcome(candidate, requestedModel || null, "disabled", reason, null, null));
      }

      const plan = planAssessmentBatch({ candidates, requestedModel, budget });
      const deadline = Date.now() + budget.timeoutMs;
      const results: EvidenceAssessmentOutcome[] = [];
      for (const entry of plan) {
        if (entry.status !== "ready") {
          results.push(outcome(
            entry.candidate,
            requestedModel,
            "skipped_budget",
            entry.reason,
            entry.cacheKey,
            entry.estimatedInputTokens,
          ));
          continue;
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          results.push(outcome(entry.candidate, requestedModel, "error", "timeout", entry.cacheKey, entry.estimatedInputTokens, {
            retryable: true,
          }));
          continue;
        }

        results.push(await assessOne({
          candidate: entry.candidate,
          requestBody: buildRequestBody(entry.candidate, requestedModel),
          cacheKey: entry.cacheKey,
          estimatedInputTokens: entry.estimatedInputTokens,
          requestedModel,
          apiKey,
          fetchImpl,
          timeoutMs: remainingMs,
        }));
      }
      return results;
    },
  };
}

async function assessOne(args: {
  candidate: EvidenceAssessmentCandidate;
  requestBody: Record<string, unknown>;
  cacheKey: string | null;
  estimatedInputTokens: number | null;
  requestedModel: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<EvidenceAssessmentOutcome> {
  try {
    validateCandidate(args.candidate);
  } catch {
    return outcome(args.candidate, args.requestedModel, "error", "invalid_request", args.cacheKey, args.estimatedInputTokens);
  }
  if (!Number.isFinite(args.timeoutMs) || !Number.isInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > MAX_TIMEOUT_MS) {
    return outcome(args.candidate, args.requestedModel, "error", "invalid_request", args.cacheKey, args.estimatedInputTokens);
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, args.timeoutMs);
  try {
    const response = await args.fetchImpl(TYPESAFE_SYSTEMONE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args.requestBody),
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryable = response.status === 429 || response.status === 529;
      return outcome(args.candidate, args.requestedModel, "error", "http_error", args.cacheKey, args.estimatedInputTokens, {
        httpStatus: response.status,
        retryable,
        latencyMs: Date.now() - startedAt,
      });
    }

    let payload: TypeSafePayload;
    try {
      payload = await response.json() as TypeSafePayload;
    } catch {
      const isTimeout = timedOut || controller.signal.aborted;
      return outcome(args.candidate, args.requestedModel, "error", isTimeout ? "timeout" : "invalid_response", args.cacheKey, args.estimatedInputTokens, {
        retryable: isTimeout,
        latencyMs: Date.now() - startedAt,
      });
    }
    if (timedOut || controller.signal.aborted) {
      return outcome(args.candidate, args.requestedModel, "error", "timeout", args.cacheKey, args.estimatedInputTokens, {
        retryable: true,
        latencyMs: Date.now() - startedAt,
      });
    }

    if (!payload || typeof payload.model !== "string" || !payload.answers || typeof payload.answers !== "object") {
      return outcome(args.candidate, args.requestedModel, "error", "invalid_response", args.cacheKey, args.estimatedInputTokens, {
        latencyMs: Date.now() - startedAt,
      });
    }

    const assessments = readAssessments(args.candidate, payload.answers);
    const scored = assessments.filter((assessment) => assessment.status === "scored").length;
    const status = scored === assessments.length ? "complete" : scored > 0 ? "partial" : "unknown";
    return {
      ...outcome(args.candidate, args.requestedModel, status, null, args.cacheKey, args.estimatedInputTokens),
      returnedModel: payload.model,
      assessments,
      usage: {
        inputTokens: finiteNonNegative(payload.usage?.input_tokens),
        outputTokens: finiteNonNegative(payload.usage?.output_tokens),
      },
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    const isTimeout = timedOut || controller.signal.aborted;
    return outcome(args.candidate, args.requestedModel, "error", isTimeout ? "timeout" : "network_error", args.cacheKey, args.estimatedInputTokens, {
      retryable: true,
      latencyMs: Date.now() - startedAt,
    });
  } finally {
    // The same signal and deadline remain in effect through response body parsing.
    clearTimeout(timer);
  }
}

function readAssessments(
  candidate: EvidenceAssessmentCandidate,
  answers: Record<string, TypeSafeAnswer>,
): DimensionAssessment[] {
  return candidate.questions.map((question) => {
    const answer = answers[question.id];
    const noul = answer?.type === "noul" ? finiteProbability(answer.noul) : null;
    return {
      id: question.id,
      dimension: question.dimension,
      status: noul === null ? "unknown" : "scored",
      noul,
    };
  });
}

function finiteProbability(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function unknownDimensions(candidate: EvidenceAssessmentCandidate): DimensionAssessment[] {
  return Array.isArray(candidate?.questions)
    ? candidate.questions.map((question) => ({ id: question.id, dimension: question.dimension, status: "unknown", noul: null }))
    : [];
}

function outcome(
  candidate: EvidenceAssessmentCandidate,
  requestedModel: string | null,
  status: EvidenceAssessmentOutcome["status"],
  reason: string | null,
  cacheKey: string | null,
  estimatedInputTokens: number | null,
  extra: Partial<Pick<EvidenceAssessmentOutcome, "httpStatus" | "retryable" | "latencyMs">> = {},
): EvidenceAssessmentOutcome {
  return {
    candidateId: candidate?.candidateId ?? "unknown",
    candidateState: candidate?.state,
    mode: "shadow",
    appliedToDecision: false,
    status,
    cacheHit: false,
    reason,
    requestedModel,
    returnedModel: null,
    cacheKey,
    rubricVersion: candidate?.rubricVersion ?? "unknown",
    assessments: unknownDimensions(candidate),
    usage: { inputTokens: null, outputTokens: null },
    estimatedInputTokens,
    latencyMs: null,
    httpStatus: null,
    retryable: false,
    ...extra,
  };
}
