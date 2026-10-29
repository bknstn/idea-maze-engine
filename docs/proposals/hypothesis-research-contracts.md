# Hypothesis research contracts

- Status: T01 contracts accepted and frozen by coordinator review on 2026-10-28.
- Schema version: `1.0.0`.
- Pre-release T08 refinement accepted on 2026-10-28: generic research `claim`
  excerpts and optional source-independence uncertainty; legacy excerpt behavior
  remains unchanged.
- Scope: domain/application/protocol contracts only. These files do not implement
  persistence, services, provider adapters, or transports.
- Planning baseline: `docs/proposals/hypothesis-research-mcp-plan.md`.
- Verification: TypeScript and all 33 test files / 205 tests passed. The small
  schema matcher in the contract tests covers the emitted subset; official SDK
  client/protocol validation remains part of T13, rather than a T01 live check.

The TypeScript source of truth is under `src/idea-maze/research/`:

- `contracts.ts` defines domain types, the shared `ResearchApplication` port,
  success/error envelopes, and the typed tool input/output map.
- `validation.ts` defines bounded runtime input parsing, explicit intake gaps,
  hard plan ceilings, and balanced query coverage checks.
- `tools.ts` exports the nine MCP tool definitions with exact JSON input/output
  schemas and annotations. Unknown properties are rejected by each schema and
  the runtime parser.
- `example.ts` contains only synthetic data and demonstrates the same app
  request/response shapes planned for both CLI and MCP.
- `contracts.test.ts` is reserved for contract tests; it will not contact a
  provider or create a database.

## Domain and versioning rules

`ResearchIntake` records `ideaSummary`, `targetUser`, `problem`,
`proposedSolution`, `currentAlternatives`, `usageFrequency`,
`budgetOrWillingnessToPay`, `decisionMaker`, and `constraints`. Omission and
`null` mean unknown. An empty alternatives or constraints array means the caller
explicitly knows of none. The first four fields and at least one active
hypothesis block planning. The other absent fields are still returned as
clarification prompts; the planner must not invent a buyer, budget, frequency,
alternative, or constraint. A case can be saved as `draft` while these fields
are missing. No discovery score or legacy approval state gates this workflow.

User assumptions enter as `user_supplied` hypotheses. A model suggestion is a
separate `unaccepted_suggestion`, with an opaque `suggestionId`; it is not an
active hypothesis and cannot be used to start a run. Accepting it requires a
later case create/update input with `origin: "model_suggested"` and the returned
`sourceSuggestionId`. The application verifies that ID against a suggestion
issued in the same workspace. Hypothesis `origin` and `sourceSuggestionId` are
immutable provenance; revising a claim creates a new hypothesis revision and
retains both values.

`research_case_update` requires `expectedRevision`. A successful update appends
an immutable case revision; a hypothesis mutation also checks its own expected
revision. A stale case returns `REVISION_CONFLICT` with the expected and current
case revision. A stale hypothesis returns `REVISION_CONFLICT` with the
hypothesis ID and its expected/current revisions. `research_case_get` without a
revision reads the latest case. Supplying `revision` reads that historical
snapshot. Revisions are never overwritten or deleted by this workflow.

A plan is bound to one exact case revision and records concrete queries,
logical source scopes, hypothesis mappings, and hard usage limits. Each active
hypothesis must have at least one supporting and one challenging query. The
`counterevidence` purpose must use challenging intent. The caller may provide a
plan for local validation without a model provider. When the plan is generated,
model use is explicit in `research_capabilities` and may send selected intake
context to the configured provider. A plan is not startable after its case
revision changes; `research_start` reports a typed plan revision conflict. A
missing case, plan, or hypothesis is a `NOT_FOUND` failure whose `details.kind`
identifies the resource.

## Evidence and assessment

A run snapshots the case revision, each hypothesis revision, and the immutable
plan. Later case edits cannot change an existing run or its results. Research
execution status is separate from assessment outcome: `completed` means the
run produced a result, and the assessment may still be
`insufficient_evidence`, including when there are zero verified excerpts.

Only `verified_excerpt` items may support, contradict, or contextualize a claim.
Each carries the existing `EvidenceExcerptV1` grounding fields: source item ID,
source text hash, exact quote, role, and zero-based UTF-16 code-unit offsets
with an end-exclusive range. The source hash and range must match the fetched
original text at verification time. `source.sourceId` is the stable string
`source_items:<positive integer>` for a legacy row and the integer must equal
`excerpt.sourceItemId`. Multiple excerpts or insight rows from the same source
version share an independence group and count as one source. Provenance proves
where an excerpt came from; it does not prove the interpretation is true.

The research-only `claim` role supports general technical and market statements
without labeling them as legacy pain signals. `provenance.ts` reuses the exact
grounding checks while preserving this role; legacy types and helpers keep their
four original roles. `independenceUncertain` is optional; omission means unknown.
Recompute source groups over the complete run evidence set after follow-ups:
immutable per-link group labels may precede a newly discovered connection.
`sourceGroupCount` counts candidate source groups; confirmed independent
authorship remains `null` without the required information.

Search result snippets are `search_snippet` discovery records. They may guide
source retrieval, but `assessmentEligible` is always `false`; they can never be
promoted to a verified quote by copying text or citing the search result URL.
Failed search, unavailable originals, access restrictions, and empty matches
are distinct `CoverageGap` reasons. A failed or unavailable provider is not
evidence of no demand. Assessments cite evidence IDs, retain conflicting claims,
report coverage gaps and missing evidence, and give a next experiment. This
contract contains no numerical success probability or aggregate market score.

## Runs, idempotency, and service ownership

All writes require an `idempotencyKey`: case create/update, plan, start, and
cancel. The key is scoped to the bound workspace and tool operation. The service
stores a digest of canonical validated input with the result. Repeating the same
key and same input replays the original response and never repeats external
work. Reusing that key with different input returns `IDEMPOTENCY_CONFLICT` and
does no work. Read tools need no key and do not start paid or external work.

There is one active run per workspace across CLI and MCP processes. An atomic
SQLite lease records its owner instance, expiry, and monotonically increasing
fencing token/epoch. Renewal and each run/step write are conditional on the
current, unexpired token. A stale owner must be rejected even if it wakes after
another process has acquired a newer epoch. Lease identity and token are
internal; they never appear in tool output or routine logs. A busy start returns
`BUSY` and the active run ID. Fencing prevents stale owners from committing
run/step state. The coordinator also checks ownership at adapter boundaries and
aborts local in-flight work on lease loss. A provider request already submitted
may outlive its owner or local cancellation; this is not a promise of remote
request rollback or exactly-once provider billing. No paid call is automatically
replayed after interruption. Deployment across replicas or a shared/network
SQLite file is outside this contract.

The `research_start` response returns the run ID promptly with `queued`; work
belongs to the service instance, not to the requesting HTTP connection. HTTP
disconnect, client timeout, or MCP session expiry does not cancel a run. The
caller reconnects and polls `research_status` or continues through the opaque,
run-scoped `research_result` cursor. `research_cancel` explicitly requests
cancellation and propagates it to active search, fetch, and model adapters.
Cancellation preserves partial evidence and assessments; a request for an
already terminal run is a no-op returning the existing status. Stopping an
HTTP client does not release the service lease.

On service shutdown, active adapters are aborted, partial results are saved,
and the run is marked `interrupted` with a stopping reason. Process crash or
lease loss is also recovered as `interrupted`; no paid step is silently
resumed. A new explicitly requested run may reuse a completed/cached step only
when its case, plan, source version, and provider configuration versions match.
When a stdio transport owns the service process, process exit is a service
shutdown and interrupts its run. Closing one HTTP client does not.

Usage limits cover query count, fetched pages, follow-up rounds, wall time, and
model input/output token caps. Provider usage is recorded where available;
unknown token counts and cost are `null`, never zero. No exact monetary cap is
claimed unless the provider can enforce/report it. Every run exposes its usage,
coverage gaps, stopping reason, and per-step state. Unconfigured/unavailable
providers are explicit capability/step states. If a run cannot search or fetch,
those steps are skipped and the completed result must say
`insufficient_evidence` with a provider coverage gap. A provider outage is not a
run failure by itself; persistence or other unrecoverable internal failures may
produce `failed`. When unavailable collection prevents further research, the
stopping reason is `provider_unavailable`; normal completion uses
`all_steps_finished`.

## Application and error contract

Each `ResearchApplication` instance is bound at construction to an explicit
workspace context. It exposes the nine shared typed methods in `contracts.ts`;
CLI and MCP adapters call these same methods. Tool input cannot choose a
workspace, database path, provider name, credential, SQL statement, shell
command, or arbitrary file path. Expected revisions and idempotency are checked
in the application/repository boundary, not trusted from the transport.

Every success is `{ schemaVersion: "1.0.0", data: ... }`. Every failure is
`{ schemaVersion: "1.0.0", error: { code, message, retryable, details } }`.
Error codes and detail variants are stable within this schema version. Unknown
exceptions map to a generic `INTERNAL_ERROR`; raw provider responses,
credentials, source bodies, and user ideas are never copied into error messages
or routine diagnostic logs. Validation reports a bounded path and issue code,
without reflecting an untrusted unknown property name.

Breaking field, enum, or semantic changes require a new schema major version.
Additive fields require a compatible version and are still rejected as unknown
until a client/server explicitly supports them. MCP output schemas describe
success and the same typed failure envelope; the protocol adapter may also set
MCP's error flag when the response is a failure. Schema validation never
replaces runtime validation.

## Tool surface

All nine names match `RESEARCH_TOOL_DEFINITIONS`. JSON Schemas are closed
objects (`additionalProperties: false`) with bounded arrays/text/results. Tool
annotations are hints; the application enforces authorization and validation.

| Tool | Input/result contract | Effects and annotations |
| --- | --- | --- |
| `research_capabilities` | Empty input; configured capability states, hard limits, single-owner mode | Read-only, idempotent, no provider call |
| `research_case_create` | Idempotency key, optional incomplete intake and hypotheses; returns case/revision/missing fields | Store write; idempotent replay; no external call |
| `research_case_get` | Case ID and optional historical revision; returns that snapshot | Read-only; no hidden work |
| `research_case_update` | Idempotency key, case ID, expected revision, intake patch and/or hypothesis mutations | Appends revisions; idempotent replay |
| `research_plan` | Idempotency key, expected case revision, optional supplied bounded plan, optional opt-in suggestions | Saves a plan or returns clarification; optional model access, so open-world hint is true |
| `research_start` | Idempotency key, case ID, expected case revision, plan ID; returns queued run ID promptly | Starts service-owned provider work; open-world hint is true |
| `research_status` | Run ID; returns state, steps, usage, coverage, stopping reason | Read-only, no hidden work |
| `research_result` | Run ID, optional cursor, page limit `1..100`, JSON/Markdown view | Read-only; returns bounded assessment/evidence pages |
| `research_cancel` | Run ID and idempotency key; returns current/requested state | Explicitly stops owned work; repeat-safe; open-world hint is true because adapters may be aborted |

The result cursor is opaque, scoped to one run and page sequence; clients return
it unchanged. Assessment and coverage are repeated on each page, and the
evidence page is capped. Markdown, if requested, renders only the same
assessment and evidence returned on that page. `research_status` and
`research_result` never initiate missing steps.

## Privacy and HTTP boundary

Case data and run state are stored on the selected owner workspace. When a
configured model or search provider is called, the smallest required case
context, outbound query, search result URL/snippet, or verified excerpt may
leave that workspace. Self-hosting does not mean all data stays on device.
Credentials are configured outside tool arguments and are not persisted in
case/run records or returned by `research_capabilities`.

The initial HTTP service is a single-owner integration for trusted clients. It
requires a configured bearer credential in the authorization header over TLS;
tokens are never accepted in query strings. Every protected request is
authenticated. Host and Origin checks, bounded request bodies, rate limits,
redacted logs, and loopback bind defaults are security requirements for T18.
Session IDs and run IDs are identifiers, not credentials. Health endpoints
reveal no research data or configuration. This is not an OAuth, public
directory, or multi-tenant contract. Stdio is a local process adapter and
inherits the invoking owner's process permissions.

## Module ownership for T02–T19

Each task owns the listed new files. No downstream task may edit T01 files or
another task's path without first sending the coordinator a concrete interface
change request. `package.json`, `package-lock.json`, shared docs indexes, and
release/ADR index edits remain coordinator-owned integration files; agents
submit requested changes instead of editing them concurrently.

| Task | Exclusive paths after T01 freeze |
| --- | --- |
| T02 | `src/idea-maze/research/repositories.ts`, `src/idea-maze/research/migrations.ts`, `src/idea-maze/research/repositories.test.ts`, and `src/idea-maze/scripts/lib/schema.ts` for migration registration |
| T03 | `src/idea-maze/research/context.ts`, `src/idea-maze/research/ports.ts`, `src/idea-maze/research/context.test.ts` |
| T04 | `src/idea-maze/research/case-service.ts`, `src/idea-maze/research/case-service.test.ts` |
| T05 | `src/idea-maze/research/planner.ts`, `src/idea-maze/research/planner.test.ts` |
| T06 | `src/idea-maze/research/search-adapter.ts`, `src/idea-maze/research/search-adapter.test.ts` |
| T07 | `src/idea-maze/research/source-reader.ts`, `src/idea-maze/research/source-reader.test.ts` |
| T08 | `src/idea-maze/research/evidence-mapper.ts`, `src/idea-maze/research/provenance.ts`, corresponding tests; coordinator-approved narrow contract/schema/verifier refinements |
| T09 | `src/idea-maze/research/assessment.ts`, `src/idea-maze/research/report-renderer.ts`, corresponding `*.test.ts` files |
| T10 | `src/idea-maze/research/run-manager.ts`, `src/idea-maze/research/run-lease.ts`, `src/idea-maze/research/run-step-executor.ts`, corresponding `*.test.ts` files |
| T11 | `src/idea-maze/research/orchestrator.ts`, `src/idea-maze/research/orchestrator.test.ts` |
| T12 | New entrypoints under `src/idea-maze/scripts/research-*.ts` and `src/idea-maze/scripts/research-cli.test.ts` |
| T13 | `src/idea-maze/mcp/tools.ts`, `src/idea-maze/mcp/stdio.ts`, `src/idea-maze/mcp/transports/streamable-http.ts`, `src/idea-maze/mcp/transport.test.ts`; coordinator adds SDK dependencies and lockfile entries |
| T14 | `src/idea-maze/research/workflow-integration.test.ts` and synthetic integration-only fixtures under `src/idea-maze/research/fixtures/` |
| T15 | `src/idea-maze/research/evaluation/` and `src/idea-maze/research/evaluation.test.ts` |
| T16 | `README.md`, new `docs/guides/hypothesis-research.md`, and the implemented decision record under `docs/adr/`; coordinator owns indexes |
| T17 | No repository implementation paths. A separately scoped, consented pilot requires explicit data/spend scope and human participants. |
| T18 | `src/idea-maze/mcp/security/http-auth.ts`, `src/idea-maze/mcp/security/http-validation.ts`, `src/idea-maze/mcp/security/http-config.ts`, `src/idea-maze/mcp/security/http-security.test.ts` |
| T19 | Root `Dockerfile`, root `compose.yaml`, `deployment/` examples, and `src/idea-maze/deployment/` smoke-test files |

The transport adapter owns protocol framing and dispatch, while T18 owns HTTP
authentication and request security. T13 must inject the security middleware
surface and keep it disabled by default outside the safe local bind until T18
integration is accepted. T12/T13 can proceed against fake services; manifest
and shared-file integration remains serialized by the coordinator. No task in
T02–T16, T18, or T19 makes live paid calls or deploys a service.
