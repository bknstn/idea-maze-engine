import { randomUUID } from "node:crypto";

import {
  RESEARCH_SCHEMA_VERSION,
  success,
  type HypothesisSuggestion,
  type PlanInput,
  type PlanResult,
  type QueryPurpose,
  type ResearchLimits,
  type ResearchCaseRevision,
  type ResearchFailure,
  type ResearchPlanDraft,
  type ResearchResponse,
  type ResearchSourceScope,
  type ResearchApplication,
} from "./contracts.js";
import type { ResearchContext } from "./context.js";
import {
  ExternalOperationOutcomeUnknownError,
  ExternalOperationPendingError,
  IdempotencyConflictError,
  PlanCaseRevisionConflictError,
  RepositoryNotFoundError,
  createResearchRepositories,
  type ExternalOperationClaim,
  type ExternalOperationUsage,
  type ResearchRepositories,
} from "./repositories.js";
import { ResearchProviderError } from "./ports.js";
import {
  ContractValidationError,
  getMissingIntakeFields,
  validateSuppliedPlan,
  validateToolInput,
  validationFailure,
} from "./validation.js";

export type ResearchPlannerApplication = Pick<ResearchApplication, "plan">;

const MODEL_OPERATION_DEADLINE_SECONDS = 120;
const PENDING_POLL_INTERVAL_MILLISECONDS = 20;
const SUGGESTION_LIMIT = 5;
const SUGGESTION_CLAIM_MAX_LENGTH = 500;

const PURPOSE_SCOPES: Record<QueryPurpose, ResearchSourceScope[]> = {
  problem_language: ["public_web", "public_reddit", "community_discussions"],
  workaround: ["public_reddit", "community_discussions"],
  alternative: ["public_web", "community_discussions"],
  counterevidence: ["public_web", "public_reddit", "community_discussions"],
};

const SUPPORTING_PURPOSES: readonly QueryPurpose[] = ["problem_language", "workaround"];
const CHALLENGING_PURPOSES: readonly QueryPurpose[] = ["counterevidence", "alternative"];
const PURPOSE_SUFFIXES: Record<QueryPurpose, string> = {
  problem_language: "site:reddit.com complaints frustrations",
  workaround: "site:reddit.com workarounds manual process",
  alternative: "alternatives existing solutions",
  counterevidence: "counterevidence objections unnecessary",
};

interface PreparedPlan {
  caseRevision: ResearchCaseRevision;
  missingFields: ReturnType<typeof getMissingIntakeFields>;
  draft: ResearchPlanDraft | null;
  needsHypothesisSuggestions: boolean;
}

class PlanLimitError extends Error {
  constructor(readonly limitName: keyof ResearchPlanDraft["limits"], readonly limit: number, readonly requested: number) {
    super("The requested research plan exceeds a configured limit.");
    this.name = "PlanLimitError";
  }
}

class InvalidModelSuggestionsError extends Error {
  constructor() {
    super("The model suggestion response did not match the bounded output shape.");
    this.name = "InvalidModelSuggestionsError";
  }
}

/**
 * Build bounded plans locally and optionally request clearly labeled hypothesis
 * suggestions through the provider-neutral research task. Provider requests are
 * reserved durably before dispatch; provider results and plan persistence are
 * committed together after rechecking the case revision.
 */
export function createResearchPlanner(
  context: ResearchContext,
  repositories: ResearchRepositories = createResearchRepositories({
    db: context.db,
    workspaceKey: context.workspaceKey,
    clock: () => context.clock.now(),
    idFactory: context.idFactory,
  }),
): ResearchPlannerApplication {
  if (repositories.workspaceKey !== context.workspaceKey) {
    throw new TypeError("Planner repositories must match the bound workspace");
  }

  return Object.freeze({
    async plan(input: PlanInput): Promise<ResearchResponse<PlanResult>> {
      if (isContextStopped(context)) return serviceUnavailableFailure();
      let request: PlanInput;
      try {
        request = validateToolInput("research_plan", input);
      } catch (error) {
        return error instanceof ContractValidationError ? validationFailure(error) : internalFailure();
      }

      try {
        const existing = repositories.externalOperations.observe<ResearchResponse<PlanResult>>(
          "research_plan", request.idempotencyKey, request,
        );
        const replay = await resolveExistingOperation(request, existing);
        if (isContextStopped(context)) return serviceUnavailableFailure();
        if (replay) return replay;

        const prepared = preparePlan(request);
        const wantsSuggestions = request.requestHypothesisSuggestions === true;
        const nonHypothesisBlockers = prepared.missingFields.some(
          (field) => field.blockingForPlanning && field.field !== "hypotheses",
        );
        const shouldCallModel = wantsSuggestions && !nonHypothesisBlockers;
        if (!shouldCallModel) return executeLocal(request);

        const model = context.providers.model;
        if (model.availability !== "available" || !model.provider) {
          return executeLocal(request, { prepared, modelUnavailable: true });
        }
        return await executeWithModel(request, prepared);
      } catch (error) {
        return failureFor(error, request.caseId);
      }
    },
  });

  function preparePlan(request: PlanInput): PreparedPlan {
    const current = repositories.cases.get(request.caseId);
    if (!current) throw new RepositoryNotFoundError("case", request.caseId);
    if (current.revision !== request.expectedCaseRevision) {
      throw new PlanCaseRevisionConflictError(request.caseId, request.expectedCaseRevision, current.revision);
    }

    const active = current.hypothesisRevisions.filter((hypothesis) => hypothesis.state === "active");
    const missingFields = getMissingIntakeFields(current.intake, active.length);
    const suppliedDraft = request.suppliedPlan
      ? validateSuppliedPlan(request.suppliedPlan, active.map((hypothesis) => hypothesis.hypothesisId))
      : null;
    if (suppliedDraft) enforceContextLimits(suppliedDraft, context.limits);
    const hasNonHypothesisBlocker = missingFields.some(
      (field) => field.blockingForPlanning && field.field !== "hypotheses",
    );
    if (hasNonHypothesisBlocker || active.length === 0) {
      return {
        caseRevision: current,
        missingFields,
        draft: null,
        needsHypothesisSuggestions: active.length === 0 && !hasNonHypothesisBlocker &&
          request.requestHypothesisSuggestions === true,
      };
    }

    const draft = suppliedDraft ?? generateBoundedPlan(current, context.limits);
    enforceContextLimits(draft, context.limits);
    return { caseRevision: current, missingFields, draft, needsHypothesisSuggestions: false };
  }

  async function executeLocal(
    request: PlanInput,
    options: { prepared?: PreparedPlan; modelUnavailable?: boolean } = {},
  ): Promise<ResearchResponse<PlanResult>> {
    try {
      const outcome = repositories.idempotency.execute<ResearchResponse<PlanResult>>(
        "research_plan",
        request.idempotencyKey,
        request,
        () => {
          if (isContextStopped(context)) return serviceUnavailableFailure();
          const current = repositories.cases.get(request.caseId);
          if (!current) throw new RepositoryNotFoundError("case", request.caseId);
          if (current.revision !== request.expectedCaseRevision) {
            throw new PlanCaseRevisionConflictError(request.caseId, request.expectedCaseRevision, current.revision);
          }
          const prepared = options.prepared ?? preparePlan(request);
          const wantsSuggestions = request.requestHypothesisSuggestions === true;
          if (options.modelUnavailable && wantsSuggestions && prepared.needsHypothesisSuggestions ||
              options.modelUnavailable && wantsSuggestions && prepared.draft !== null) {
            return providerUnavailableFailure(context.providers.model.availability);
          }
          if (prepared.draft === null) {
            return success({
              status: "needs_clarification",
              caseId: request.caseId,
              caseRevision: current.revision,
              plan: null,
              missingFields: prepared.missingFields,
              hypothesisSuggestions: [],
            });
          }

          const plan = repositories.plans.create({
            caseId: request.caseId,
            caseRevision: current.revision,
            queries: prepared.draft.queries,
            limits: prepared.draft.limits,
          });
          return success({
            status: "ready",
            caseId: request.caseId,
            caseRevision: current.revision,
            plan,
            missingFields: prepared.missingFields,
            hypothesisSuggestions: [],
          });
        },
      );
      return outcome.value;
    } catch (error) {
      if (error instanceof ExternalOperationPendingError) {
        const existing = repositories.externalOperations.observe<ResearchResponse<PlanResult>>(
          "research_plan", request.idempotencyKey, request,
        );
        return (await resolveExistingOperation(request, existing)) ?? internalFailure();
      }
      if (error instanceof ExternalOperationOutcomeUnknownError) return unknownOutcomeFailure();
      return failureFor(error, request.caseId);
    }
  }

  async function executeWithModel(
    request: PlanInput,
    prepared: PreparedPlan,
  ): Promise<ResearchResponse<PlanResult>> {
    const model = context.providers.model.provider;
    if (!model) return providerUnavailableFailure(context.providers.model.availability);
    if (isContextStopped(context)) return serviceUnavailableFailure();

    const deadlineSeconds = Math.min(MODEL_OPERATION_DEADLINE_SECONDS, context.limits.maxWallTimeSeconds);
    const now = context.clock.now();
    const nowMilliseconds = now instanceof Date ? now.getTime() : Date.parse(now);
    const deadlineAt = new Date(nowMilliseconds + deadlineSeconds * 1000).toISOString();
    const ownerId = randomUUID();
    const reservation = repositories.externalOperations.reserve<ResearchResponse<PlanResult>>({
      operation: "research_plan",
      key: request.idempotencyKey,
      validatedInput: request,
      ownerId,
      deadlineAt,
    });
    if (reservation.kind === "replay") return reservation.value;
    if (reservation.kind === "unknown") return unknownOutcomeFailure();
    if (reservation.kind === "pending") {
      return (await resolveExistingOperation(request, reservation)) ?? unknownOutcomeFailure();
    }
    if (reservation.kind !== "claimed") return internalFailure();

    const claim: ExternalOperationClaim = reservation.claim;
    const deadlineMilliseconds = deadlineSeconds * 1000;
    const scope = createDeadlineSignal(context, deadlineMilliseconds);
    const startedAt = Date.now();
    safeLog({ event: "provider.request_started", capability: "model", adapter: context.providers.model.adapter ?? undefined, task: "research" });
    let observedUsage: ExternalOperationUsage | undefined;

    try {
      const providerInput = modelSuggestionInput(prepared.caseRevision);
      // Re-read the durable claim at the dispatch boundary. A process pause
      // between reserve and here must not turn an expired claim into new work.
      const preflight = repositories.externalOperations.observe<ResearchResponse<PlanResult>>(
        "research_plan", request.idempotencyKey, request,
      );
      if (preflight.kind === "replay") return preflight.value;
      if (preflight.kind === "unknown") return unknownOutcomeFailure();
      if (preflight.kind !== "pending" || preflight.ownerId !== claim.ownerId ||
          preflight.fencingToken !== claim.fencingToken) {
        return internalFailure();
      }
      if (isContextStopped(context)) {
        const stopped = repositories.externalOperations.complete<ResearchResponse<PlanResult>>({
          operation: "research_plan",
          key: request.idempotencyKey,
          validatedInput: request,
          claim,
          effect: () => serviceUnavailableFailure(),
        });
        return stopped.kind === "completed" ? stopped.value : unknownOutcomeFailure();
      }
      if (scope.signal.aborted) {
        repositories.externalOperations.markUnknown({
          operation: "research_plan", key: request.idempotencyKey, validatedInput: request, claim,
        });
        return unknownOutcomeFailure();
      }

      const providerPromise = model.generateJson<unknown>({
        task: "research",
        maxInputTokens: context.limits.maxModelInputTokens,
        maxOutputTokens: context.limits.maxModelOutputTokens,
        systemPrompt: "Suggest a small set of testable product research claims using only the explicit case context. Do not fill in unknown buyer, budget, frequency, decision-maker, or alternatives. Return JSON with exactly one property, claims, containing one to five concise claims. These are unaccepted suggestions, never decisions or facts.",
        userPrompt: JSON.stringify(providerInput),
        signal: scope.signal,
      });
      const response = await awaitAbortable(providerPromise, scope.signal);
      observedUsage = normalizeProviderUsage(response.usage);
      if (scope.signal.aborted || isContextStopped(context)) {
        repositories.externalOperations.markUnknown({
          operation: "research_plan", key: request.idempotencyKey, validatedInput: request, claim,
          usage: observedUsage,
        });
        return unknownOutcomeFailure();
      }
      const claims = validateModelSuggestions(response.value);
      const completed = repositories.externalOperations.complete<ResearchResponse<PlanResult>>({
        operation: "research_plan",
        key: request.idempotencyKey,
        validatedInput: request,
        claim,
        usage: observedUsage,
        effect: () => persistModelResult(request, prepared, claims),
      });
      safeLog({
        event: "provider.request_finished",
        capability: "model",
        adapter: context.providers.model.adapter ?? undefined,
        task: "research",
        outcome: "succeeded",
        durationMilliseconds: Math.max(0, Date.now() - startedAt),
        itemCount: claims.length,
      });
      return completed.kind === "completed" ? completed.value : unknownOutcomeFailure();
    } catch (error) {
      if (scope.signal.aborted || isAbortError(error) || isContextStopped(context)) {
        try {
          repositories.externalOperations.markUnknown({
            operation: "research_plan", key: request.idempotencyKey, validatedInput: request, claim,
            usage: observedUsage,
          });
        } catch {
          // The durable claim remains pending and will become unknown at its persisted deadline.
        }
        safeLog({
          event: "provider.request_failed", capability: "model", adapter: context.providers.model.adapter ?? undefined,
          task: "research", outcome: "cancelled", durationMilliseconds: Math.max(0, Date.now() - startedAt),
        });
        return unknownOutcomeFailure();
      }

      const cachedFailure = providerFailure(error);
      try {
        const completed = repositories.externalOperations.complete<ResearchResponse<PlanResult>>({
          operation: "research_plan",
          key: request.idempotencyKey,
          validatedInput: request,
          claim,
          usage: observedUsage,
          effect: () => cachedFailure,
        });
        safeLog({
          event: "provider.request_failed", capability: "model", adapter: context.providers.model.adapter ?? undefined,
          task: "research", outcome: "failed", durationMilliseconds: Math.max(0, Date.now() - startedAt),
        });
        return completed.kind === "completed" ? completed.value : unknownOutcomeFailure();
      } catch {
        return internalFailure();
      }
    } finally {
      scope.dispose();
    }
  }

  function persistModelResult(
    request: PlanInput,
    originallyPrepared: PreparedPlan,
    claims: readonly string[],
  ): ResearchResponse<PlanResult> {
    if (isContextStopped(context)) return serviceUnavailableFailure();
    const current = repositories.cases.get(request.caseId);
    if (!current) return notFound("case", request.caseId);
    if (current.revision !== request.expectedCaseRevision) {
      return revisionConflict(request.caseId, request.expectedCaseRevision, current.revision);
    }

    const active = current.hypothesisRevisions.filter((hypothesis) => hypothesis.state === "active");
    const missingFields = getMissingIntakeFields(current.intake, active.length);
    const suggestions: HypothesisSuggestion[] = claims.map((claim) => repositories.suggestions.create(claim));
    if (active.length === 0) {
      return success({
        status: "needs_clarification",
        caseId: request.caseId,
        caseRevision: current.revision,
        plan: null,
        missingFields,
        hypothesisSuggestions: suggestions,
      });
    }

    // The revision check above makes the prepared draft an exact snapshot match.
    // Rebuild to guard against callers ever passing a mismatched prepared value.
    const draft = originallyPrepared.draft ?? preparePlan(request).draft;
    if (!draft) return internalFailure();
    const plan = repositories.plans.create({
      caseId: request.caseId,
      caseRevision: current.revision,
      queries: draft.queries,
      limits: draft.limits,
    });
    return success({
      status: "ready",
      caseId: request.caseId,
      caseRevision: current.revision,
      plan,
      missingFields,
      hypothesisSuggestions: suggestions,
    });
  }

  async function resolveExistingOperation(
    request: PlanInput,
    initial: ReturnType<ResearchRepositories["externalOperations"]["observe"]>,
  ): Promise<ResearchResponse<PlanResult> | null> {
    let observation = initial;
    let localWaitDeadline = Number.POSITIVE_INFINITY;
    if (observation.kind === "pending") {
      const clockNow = context.clock.now();
      const clockMilliseconds = clockNow instanceof Date ? clockNow.getTime() : Date.parse(clockNow);
      const remaining = Math.max(1, Date.parse(observation.deadlineAt) - clockMilliseconds);
      localWaitDeadline = Date.now() + Math.min(remaining, MODEL_OPERATION_DEADLINE_SECONDS * 1000);
    }
    while (true) {
      if (observation.kind === "replay") return observation.value as ResearchResponse<PlanResult>;
      if (observation.kind === "unknown") return unknownOutcomeFailure();
      if (observation.kind === "absent" || observation.kind === "claimed") return null;
      if (isContextStopped(context)) return serviceUnavailableFailure();

      if (Date.now() >= localWaitDeadline) {
        repositories.externalOperations.markUnknown({
          operation: "research_plan",
          key: request.idempotencyKey,
          validatedInput: request,
          claim: { ownerId: observation.ownerId, fencingToken: observation.fencingToken },
        });
        observation = repositories.externalOperations.observe<ResearchResponse<PlanResult>>(
          "research_plan", request.idempotencyKey, request,
        );
        if (observation.kind === "replay") return observation.value as ResearchResponse<PlanResult>;
        return unknownOutcomeFailure();
      }

      const deadline = Date.parse(observation.deadlineAt);
      const clockNow = context.clock.now();
      const clockMilliseconds = clockNow instanceof Date ? clockNow.getTime() : Date.parse(clockNow);
      const remaining = deadline - clockMilliseconds;
      if (remaining <= 0) {
        observation = repositories.externalOperations.observe<ResearchResponse<PlanResult>>(
          "research_plan", request.idempotencyKey, request,
        );
        continue;
      }
      await delay(Math.min(PENDING_POLL_INTERVAL_MILLISECONDS, remaining));
      observation = repositories.externalOperations.observe<ResearchResponse<PlanResult>>(
        "research_plan", request.idempotencyKey, request,
      );
    }
  }

  function safeLog(entry: Parameters<ResearchContext["logger"]["log"]>[0]): void {
    try {
      context.logger.log(entry);
    } catch {
      // Diagnostics must not change provider or persistence outcomes.
    }
  }
}

function generateBoundedPlan(caseRevision: ResearchCaseRevision, limits: Readonly<ResearchLimits>): ResearchPlanDraft {
  const active = caseRevision.hypothesisRevisions.filter((hypothesis) => hypothesis.state === "active");

  const problemTerms = compactTerms(caseRevision.intake.problem ?? "", 5);
  const targetTerms = compactTerms(caseRevision.intake.targetUser ?? "", 3);
  const queries: ResearchPlanDraft["queries"] = [];
  for (const [index, hypothesis] of active.entries()) {
    const claimTerms = compactTerms(hypothesis.claim, 6);
    const supportingPurpose = SUPPORTING_PURPOSES[index % SUPPORTING_PURPOSES.length];
    const challengingPurpose = CHALLENGING_PURPOSES[index % CHALLENGING_PURPOSES.length];
    queries.push(makeQuery(
      makeQueryText(supportingPurpose, problemTerms, claimTerms, targetTerms),
      supportingPurpose,
      "supporting",
      hypothesis.hypothesisId,
    ));
    queries.push(makeQuery(
      makeQueryText(challengingPurpose, problemTerms, claimTerms, targetTerms),
      challengingPurpose,
      "challenging",
      hypothesis.hypothesisId,
    ));
  }

  if (active.length === 1) {
    const hypothesisId = active[0].hypothesisId;
    queries.push(makeQuery(
      makeQueryText("workaround", problemTerms, compactTerms(active[0].claim, 6), targetTerms),
      "workaround",
      "supporting",
      hypothesisId,
    ));
    queries.push(makeQuery(
      makeQueryText("alternative", problemTerms, compactTerms(active[0].claim, 6), targetTerms),
      "alternative",
      "challenging",
      hypothesisId,
    ));
  }

  const mergedQueries = mergeDuplicateQueries(queries);
  if (mergedQueries.length > limits.maxQueries) {
    throw new PlanLimitError("maxQueries", limits.maxQueries, mergedQueries.length);
  }
  const draft: ResearchPlanDraft = {
    queries: mergedQueries,
    limits: { ...limits },
  };
  return validateSuppliedPlan(draft, active.map((hypothesis) => hypothesis.hypothesisId));
}

function makeQuery(
  text: string,
  purpose: QueryPurpose,
  evidenceIntent: "supporting" | "challenging",
  hypothesisId: string,
) {
  return {
    text: text.slice(0, 240),
    purpose,
    evidenceIntent,
    hypothesisIds: [hypothesisId],
    sourceScopes: [...PURPOSE_SCOPES[purpose]],
  };
}

function makeQueryText(
  purpose: QueryPurpose,
  problemTerms: string,
  claimTerms: string,
  targetTerms: string,
): string {
  const problem = quoteTerms(boundedPhrase(problemTerms || claimTerms, 56));
  const claim = quoteTerms(boundedPhrase(claimTerms || problemTerms, 64));
  const target = boundedPhrase(targetTerms, 24);
  const context = `${problem}${target ? ` ${target}` : ""} ${claim}`;
  const suffix = PURPOSE_SUFFIXES[purpose];
  const boundedContext = context.slice(0, Math.max(0, 239 - suffix.length)).trimEnd();
  return `${boundedContext} ${suffix}`;
}

function compactTerms(value: string, maxWords: number): string {
  const stopWords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "into",
    "is", "it", "may", "of", "on", "or", "that", "the", "their", "this", "to", "use", "uses", "using",
    "was", "were", "will", "with",
  ]);
  const words = value.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [];
  const selected = words
    .filter((word) => !stopWords.has(word.toLocaleLowerCase("en-US")))
    .slice(0, maxWords)
    .map((word) => word.slice(0, 32));
  return selected.join(" ").toLocaleLowerCase("en-US");
}

function boundedPhrase(value: string, maxCharacters: number): string {
  return value.slice(0, maxCharacters).trimEnd();
}

function quoteTerms(value: string): string {
  return value ? `"${value}"` : "product research";
}

function mergeDuplicateQueries(queries: ResearchPlanDraft["queries"]): ResearchPlanDraft["queries"] {
  const merged = new Map<string, ResearchPlanDraft["queries"][number]>();
  for (const query of queries) {
    const key = `${query.purpose}\u0000${query.evidenceIntent}\u0000${query.text.toLocaleLowerCase("en-US")}`;
    const existing = merged.get(key);
    if (existing) {
      for (const hypothesisId of query.hypothesisIds) {
        if (!existing.hypothesisIds.includes(hypothesisId)) existing.hypothesisIds.push(hypothesisId);
      }
    } else {
      merged.set(key, { ...query, hypothesisIds: [...query.hypothesisIds] });
    }
  }
  return [...merged.values()];
}

function enforceContextLimits(draft: ResearchPlanDraft, contextLimits: Readonly<ResearchPlanDraft["limits"]>): void {
  for (const key of Object.keys(contextLimits) as Array<keyof ResearchPlanDraft["limits"]>) {
    if (draft.limits[key] > contextLimits[key]) {
      throw new PlanLimitError(key, contextLimits[key], draft.limits[key]);
    }
  }
  if (draft.queries.length > contextLimits.maxQueries) {
    throw new PlanLimitError("maxQueries", contextLimits.maxQueries, draft.queries.length);
  }
}

function modelSuggestionInput(caseRevision: ResearchCaseRevision): Record<string, unknown> {
  const intake = caseRevision.intake;
  return {
    ideaSummary: intake.ideaSummary,
    targetUser: intake.targetUser,
    problem: intake.problem,
    proposedSolution: intake.proposedSolution,
    currentAlternatives: intake.currentAlternatives,
    usageFrequency: intake.usageFrequency,
    budgetOrWillingnessToPay: intake.budgetOrWillingnessToPay,
    decisionMaker: intake.decisionMaker,
    constraints: intake.constraints,
    activeHypotheses: caseRevision.hypothesisRevisions
      .filter((hypothesis) => hypothesis.state === "active")
      .map((hypothesis) => hypothesis.claim),
  };
}

function validateModelSuggestions(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidModelSuggestionsError();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.prototype.hasOwnProperty.call(record, "claims") ||
      !Array.isArray(record.claims) || record.claims.length < 1 || record.claims.length > SUGGESTION_LIMIT) {
    throw new InvalidModelSuggestionsError();
  }
  const claims = record.claims.map((claim) => {
    if (typeof claim !== "string") throw new InvalidModelSuggestionsError();
    const trimmed = claim.trim();
    if (trimmed.length < 8 || trimmed.length > SUGGESTION_CLAIM_MAX_LENGTH ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(trimmed)) {
      throw new InvalidModelSuggestionsError();
    }
    return trimmed;
  });
  if (new Set(claims.map((claim) => claim.toLocaleLowerCase("en-US"))).size !== claims.length) {
    throw new InvalidModelSuggestionsError();
  }
  return claims;
}

function createDeadlineSignal(context: ResearchContext, deadlineMilliseconds: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const serviceScope = context.createProviderSignal();
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new DOMException("Research operation deadline reached", "AbortError"));
  };
  if (serviceScope.signal.aborted) abort();
  else serviceScope.signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, deadlineMilliseconds);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      serviceScope.signal.removeEventListener("abort", abort);
      serviceScope.dispose();
    },
  };
}

function awaitAbortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: T | unknown) => void, value: T | unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      finish(reject, signal.reason instanceof Error ? signal.reason : new DOMException("Research operation aborted", "AbortError"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    // Keep handlers attached after abort so a late provider rejection is consumed;
    // a late value is deliberately ignored and cannot be persisted by this caller.
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function normalizeProviderUsage(value: unknown): { inputTokens: number | null; outputTokens: number | null; costMicros: number | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { inputTokens: null, outputTokens: null, costMicros: null };
  }
  const record = value as Record<string, unknown>;
  const safeCount = (candidate: unknown): number | null =>
    Number.isSafeInteger(candidate) && (candidate as number) >= 0 ? candidate as number : null;
  return {
    inputTokens: safeCount(record.inputTokens),
    outputTokens: safeCount(record.outputTokens),
    costMicros: safeCount(record.costMicros),
  };
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, milliseconds)));
}

function isContextStopped(context: ResearchContext): boolean {
  return context.isDisposed || context.serviceSignal.aborted;
}

function failureFor(error: unknown, caseId: string): ResearchFailure {
  if (error instanceof ContractValidationError) return validationFailure(error);
  if (error instanceof IdempotencyConflictError) {
    return {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "The idempotency key was already used with different input.",
        retryable: false,
        details: { kind: "idempotency_conflict", operation: error.operation },
      },
    };
  }
  if (error instanceof PlanCaseRevisionConflictError) {
    return revisionConflict(error.caseId, error.expectedRevision, error.currentRevision);
  }
  if (error instanceof RepositoryNotFoundError) {
    const resource = error.resource === "case" ? "case" : "hypothesis";
    return notFound(resource, error.id);
  }
  if (error instanceof PlanLimitError) return limitExceeded(error.limitName, error.limit, error.requested);
  if (error instanceof ExternalOperationOutcomeUnknownError) return unknownOutcomeFailure();
  if (error instanceof ExternalOperationPendingError) {
    return internalFailure("The existing operation is still pending; retry this same request to collect its result.");
  }
  if (error instanceof ResearchProviderError) return providerFailure(error);
  return internalFailure();
}

function providerFailure(error: unknown): ResearchFailure {
  if (error instanceof ResearchProviderError && error.kind === "unavailable") {
    return {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "The model request failed after dispatch and is cached for this key. Use a new idempotency key to request new work.",
        retryable: false,
        details: { kind: "provider_unavailable", capability: "model", availability: "unavailable" },
      },
    };
  }
  if (error instanceof ResearchProviderError && error.kind === "rate_limited") {
    return {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      error: {
        code: "RATE_LIMITED",
        message: "The model provider is rate limited; this result is cached for the key. Use a new idempotency key to try again.",
        retryable: false,
        details: { kind: "rate_limited", retryAfterSeconds: error.retryAfterSeconds },
      },
    };
  }
  return internalFailure("The model request failed after dispatch and is cached for this key. Use a new idempotency key to request new work.");
}

function providerUnavailableFailure(availability: "not_configured" | "unavailable" | "available"): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: {
      code: "PROVIDER_UNAVAILABLE",
      message: "The requested model capability is not available.",
      retryable: false,
      details: {
        kind: "provider_unavailable",
        capability: "model",
        availability: availability === "available" ? "unavailable" : availability,
      },
    },
  };
}

function limitExceeded(name: keyof ResearchPlanDraft["limits"], limit: number, requested: number): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: {
      code: "LIMIT_EXCEEDED",
      message: "The requested research plan exceeds a configured limit.",
      retryable: false,
      details: { kind: "limit_exceeded", limitName: name, limit, requested },
    },
  };
}

function revisionConflict(caseId: string, expectedRevision: number, currentRevision: number): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: {
      code: "REVISION_CONFLICT",
      message: "The case revision is stale.",
      retryable: false,
      details: { kind: "revision_conflict", caseId, expectedRevision, currentRevision },
    },
  };
}

function notFound(resource: "case" | "hypothesis", id: string): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: {
      code: "NOT_FOUND",
      message: `The ${resource} was not found in this workspace.`,
      retryable: false,
      details: { kind: "not_found", resource, id },
    },
  };
}

function unknownOutcomeFailure(): ResearchFailure {
  return internalFailure("The prior model request has an unknown outcome and was not repeated. Use a new idempotency key to request new work.");
}

function internalFailure(message = "The research request could not be completed."): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: { code: "INTERNAL_ERROR", message, retryable: false, details: { kind: "internal" } },
  };
}

function serviceUnavailableFailure(): ResearchFailure {
  return internalFailure("The research service is not active.");
}
