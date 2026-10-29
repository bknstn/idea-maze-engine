import {
  type CaseCreateInput,
  type CaseGetInput,
  type CaseUpdateInput,
  type HypothesisMutation,
  type HypothesisRevision,
  RESEARCH_SCHEMA_VERSION,
  type ResearchApplication,
  type ResearchCase,
  type ResearchCaseRevision,
  type ResearchFailure,
  type ResearchResponse,
  success,
} from "./contracts.js";
import type { ResearchContext } from "./context.js";
import {
  CaseRevisionConflictError,
  HypothesisRevisionConflictError,
  IdempotencyConflictError,
  RepositoryNotFoundError,
  createResearchRepositories,
  type ResearchRepositories,
} from "./repositories.js";
import {
  ContractValidationError,
  getMissingIntakeFields,
  validateToolInput,
  validationFailure,
} from "./validation.js";

export type ResearchCaseApplication = Pick<ResearchApplication, "createCase" | "getCase" | "updateCase">;

/**
 * Bind the case intake surface to one explicit workspace and its SQLite
 * repositories. The returned methods share the application contract but do
 * not provide placeholder implementations for planning or run operations.
 */
export function createResearchCaseService(
  context: ResearchContext,
  repositories: ResearchRepositories = createResearchRepositories({
    db: context.db,
    workspaceKey: context.workspaceKey,
    clock: () => context.clock.now(),
    idFactory: context.idFactory,
  }),
): ResearchCaseApplication {
  if (repositories.workspaceKey !== context.workspaceKey) {
    throw new TypeError("Case repositories must match the bound workspace");
  }

  return Object.freeze({
    async createCase(input: CaseCreateInput): Promise<ResearchResponse<{ case: ResearchCase }>> {
      if (isContextStopped(context)) return serviceUnavailableFailure();
      let request: CaseCreateInput;
      try {
        request = validateToolInput("research_case_create", input);
      } catch (error) {
        return validationOrInternal(error);
      }

      try {
        const outcome = repositories.idempotency.execute(
          "research_case_create",
          request.idempotencyKey,
          request,
          () => {
            validateSuggestionSubmissions(request.hypotheses ?? [], repositories, "hypotheses");
            const revision = repositories.cases.create({
              ...(request.intake === undefined ? {} : { intake: request.intake }),
              ...(request.hypotheses === undefined ? {} : { hypotheses: request.hypotheses }),
            });
            const view = toResearchCase(revision, repositories);
            return success({ case: view });
          },
        );
        return outcome.value;
      } catch (error) {
        return failureFor(error);
      }
    },

    async getCase(input: CaseGetInput): Promise<ResearchResponse<ResearchCase>> {
      if (isContextStopped(context)) return serviceUnavailableFailure();
      let request: CaseGetInput;
      try {
        request = validateToolInput("research_case_get", input);
      } catch (error) {
        return validationOrInternal(error);
      }

      try {
        const revision = repositories.cases.get(request.caseId, request.revision);
        if (!revision) return notFound("case", request.caseId);
        return success(toResearchCase(revision, repositories));
      } catch {
        return internalFailure();
      }
    },

    async updateCase(input: CaseUpdateInput): Promise<ResearchResponse<{ case: ResearchCase }>> {
      if (isContextStopped(context)) return serviceUnavailableFailure();
      let request: CaseUpdateInput;
      try {
        request = validateToolInput("research_case_update", input);
      } catch (error) {
        return validationOrInternal(error);
      }

      try {
        const outcome = repositories.idempotency.execute(
          "research_case_update",
          request.idempotencyKey,
          request,
          () => {
            const current = repositories.cases.get(request.caseId);
            if (!current) throw new RepositoryNotFoundError("case", request.caseId);
            if (current.revision !== request.expectedRevision) {
              throw new CaseRevisionConflictError(request.caseId, request.expectedRevision, current.revision);
            }
            validateSuggestionMutations(request.hypothesisMutations ?? [], repositories);
            validateHypothesisMutationBounds(current.hypothesisRevisions, request.hypothesisMutations ?? []);

            const revision = repositories.cases.update({
              caseId: request.caseId,
              expectedRevision: request.expectedRevision,
              ...(request.intakePatch === undefined ? {} : { intakePatch: request.intakePatch }),
              ...(request.hypothesisMutations === undefined ? {} : { hypothesisMutations: request.hypothesisMutations }),
            });
            return success({ case: toResearchCase(revision, repositories) });
          },
        );
        return outcome.value;
      } catch (error) {
        return failureFor(error, request.caseId);
      }
    },
  });
}

function toResearchCase(revision: ResearchCaseRevision, repositories: ResearchRepositories): ResearchCase {
  const firstRevision = repositories.cases.get(revision.caseId, 1);
  if (!firstRevision) throw new Error("The case creation revision is missing");
  const activeCount = revision.hypothesisRevisions.filter((hypothesis) => hypothesis.state === "active").length;
  const missingFields = getMissingIntakeFields(revision.intake, activeCount);
  return {
    caseId: revision.caseId,
    revision: revision.revision,
    status: missingFields.some((field) => field.blockingForPlanning) ? "draft" : "ready",
    intake: revision.intake,
    hypotheses: revision.hypothesisRevisions,
    missingFields,
    createdAt: firstRevision.createdAt,
    updatedAt: revision.createdAt,
  };
}

function validateSuggestionSubmissions(
  submissions: ReadonlyArray<{ origin?: string; sourceSuggestionId?: string }>,
  repositories: ResearchRepositories,
  path: string,
): void {
  submissions.forEach((submission, index) => {
    if (submission.origin === "model_suggested" &&
        (!submission.sourceSuggestionId || !repositories.suggestions.exists(submission.sourceSuggestionId))) {
      throw new ContractValidationError(`${path}[${index}].sourceSuggestionId`, "invalid_value");
    }
  });
}

function validateSuggestionMutations(
  mutations: readonly HypothesisMutation[],
  repositories: ResearchRepositories,
): void {
  mutations.forEach((mutation, index) => {
    if (mutation.operation === "add" && mutation.origin === "model_suggested" &&
        !repositories.suggestions.exists(mutation.sourceSuggestionId)) {
      throw new ContractValidationError(`hypothesisMutations[${index}].sourceSuggestionId`, "invalid_value");
    }
  });
}

function validateHypothesisMutationBounds(
  existing: readonly HypothesisRevision[],
  mutations: readonly HypothesisMutation[],
): void {
  const projectedCount = existing.length + mutations.filter((mutation) => mutation.operation === "add").length;
  if (projectedCount > 20) {
    throw new ContractValidationError("hypothesisMutations", "out_of_range");
  }

  const byId = new Map(existing.map((hypothesis) => [hypothesis.hypothesisId, hypothesis]));
  mutations.forEach((mutation, index) => {
    if (mutation.operation !== "retire") return;
    const target = byId.get(mutation.hypothesisId);
    if (target?.state === "retired" && target.revision === mutation.expectedRevision) {
      throw new ContractValidationError(`hypothesisMutations[${index}].hypothesisId`, "invalid_value");
    }
  });
}

function validationOrInternal(error: unknown): ResearchFailure {
  return error instanceof ContractValidationError ? validationFailure(error) : internalFailure();
}

function failureFor(error: unknown, caseId?: string): ResearchFailure {
  if (error instanceof ContractValidationError) return validationFailure(error);
  if (error instanceof CaseRevisionConflictError) {
    return {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      error: {
        code: "REVISION_CONFLICT",
        message: "The case revision is stale.",
        retryable: false,
        details: {
          kind: "revision_conflict",
          caseId: error.caseId,
          expectedRevision: error.expectedRevision,
          currentRevision: error.currentRevision,
        },
      },
    };
  }
  if (error instanceof HypothesisRevisionConflictError && caseId) {
    return {
      schemaVersion: RESEARCH_SCHEMA_VERSION,
      error: {
        code: "REVISION_CONFLICT",
        message: "The hypothesis revision is stale.",
        retryable: false,
        details: {
          kind: "hypothesis_revision_conflict",
          caseId,
          hypothesisId: error.hypothesisId,
          expectedRevision: error.expectedRevision,
          currentRevision: error.currentRevision,
        },
      },
    };
  }
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
  if (error instanceof RepositoryNotFoundError) {
    if (error.resource === "case") return notFound("case", error.id);
    if (error.resource === "hypothesis") return notFound("hypothesis", error.id);
  }
  return internalFailure();
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

function internalFailure(): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: {
      code: "INTERNAL_ERROR",
      message: "The research request could not be completed.",
      retryable: false,
      details: { kind: "internal" },
    },
  };
}

function isContextStopped(context: ResearchContext): boolean {
  return context.isDisposed || context.serviceSignal.aborted;
}

function serviceUnavailableFailure(): ResearchFailure {
  return {
    schemaVersion: RESEARCH_SCHEMA_VERSION,
    error: {
      code: "INTERNAL_ERROR",
      message: "The research service is not active.",
      retryable: false,
      details: { kind: "internal" },
    },
  };
}
