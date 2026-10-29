# User-led hypothesis research and MCP delivery plan

- Status: Agreed product direction; implementation authorized and partially complete
- Prepared: 2026-10-28
- GitHub baseline: [epic #8](https://github.com/bknstn/idea-maze-engine/issues/8), with 19 linked backlog issues
- Related: [product exploration issue #7](https://github.com/bknstn/idea-maze-engine/issues/7)
- Delegation: bounded tasks suitable for Luna with xhigh reasoning; architecture and integration reviewed by a coordinating agent
- Execution: implementation authorized on 2026-10-28 and continuation/publication authorized on 2026-10-29. Deployment and the human pilot retain their separate scope requirements.

## Product outcome

A user or general-purpose assistant submits a product idea, investigates its
critical assumptions, and receives traceable supporting and opposing evidence,
coverage limitations, and a next experiment. CLI and a self-hostable MCP server expose
the same application services. An idea does not need a discovery score of 9 to
be researched. Insufficient evidence remains a useful result.

The first audience is technical founders and researchers already using an agent
client. Validate usefulness against an ordinary chat-based research workflow
before investing in public multi-tenant distribution.

## Verified starting point

- Reddit ingestion reads selected communities' recent RSS feeds; it is not a
  targeted historical search or a full comment crawler.
- Refresh groups the latest 500 insights by a top keyword and takes one ranked
  summary as the thesis. This is not semantic problem clustering.
- Automatic processing requires a high score and evidence gates; incomplete
  evidence can cause archiving before research enrichment.
- Manual research already accepts an ad-hoc topic, but does not provide the
  hypothesis-driven collection loop proposed here.
- Optional Tavily enrichment is bounded and search results are contextual.
- SQLite, source hashes, verified excerpts, audit events, provider adapters,
  human review, and exploration structures are reusable foundations.
- Database and paths currently have process-global state. New services need
  explicit context rather than closing a shared connection per tool call.
- Existing quote evaluations do not establish product-discovery usefulness.

References: `refresh-opportunities.ts`, `process-opportunities.ts`, and
`lib/{research,search,evidence-quality,db,paths,exploration}.ts` under
`src/idea-maze/scripts/`; the existing quote evaluation report.

## Scope and boundaries

Required for the first release:

1. Structured idea and hypothesis intake, including externally supplied hypotheses.
2. Search planning, bounded collection, original-source verification, and coverage.
3. Claim-level assessments and a portable report with a next experiment.
4. Durable runs owned by the service, explicit budgets, cancellation, and retry-safe requests.
5. CLI plus MCP over Streamable HTTP, with stdio as an additional local adapter.
   Include authentication, container deployment, persistent storage, and client tests.
6. Offline regression evaluation and a separately authorized live pilot.

Deferred: public website, hosted multi-tenant service, OAuth-based public distribution,
public ChatGPT plugin distribution, scheduled monitoring, new private data
connectors, trend scoring, rewriting discovery clustering, and globally relaxing
the existing discovery gates. These remain possible follow-up projects.

The MCP server is a required deliverable, not a future wrapper left outside the
release. The first release serves one owner and their trusted agent clients per
installation, locally or on a self-hosted server. It does not claim
that all ChatGPT distribution requirements have been implemented.

## Architecture contract to freeze in task T01

```text
CLI commands                  MCP tools (HTTP / stdio)
      \                         /
       Application services / explicit workspace context
          |              |                 |
     SQLite store    Run coordinator   Research steps
                                         |
                         Search / fetch / LLM adapters
```

Keep new code under `src/idea-maze/`, with domain/application code in
`research/`, CLI entrypoints in `scripts/`, and protocol code in `mcp/`.
Exact filenames are frozen in T01 to prevent overlapping agent edits.
Reuse existing library functions where their contracts fit; avoid a repository-wide
rewrite. Legacy discovery commands and lifecycle semantics remain compatible.

Proposed entities:

- `ResearchCase`: versioned idea, audience, problem, proposed solution,
  alternatives, constraints, and explicit user-supplied assumptions.
- `Hypothesis`: a testable claim linked to a case revision; distinguish user
  statements from model suggestions. Update by revision, not silent overwrite.
- `ResearchRun`: immutable case/plan snapshot, execution state, budgets,
  provider availability, steps, timestamps, and usage.
- `EvidenceLink`: hypothesis, source version, verified excerpt, relationship
  (`supports`, `contradicts`, `context`), and interpretation. A verified quote
  proves provenance, not that its interpretation or market claim is true.
- `Assessment`: `supported`, `mixed`, `contradicted`, or `insufficient_evidence`,
  with strength rationale, coverage limits, missing evidence, and next action.

Use separate case/run/link tables for this workflow; share source storage where
appropriate. Do not make the legacy opportunity approval lifecycle a prerequisite.
Keep run execution states separate from assessment outcomes: a successfully
completed run can conclude `insufficient_evidence`.

Intake may save an incomplete draft. Planning returns concrete missing fields
instead of inventing buyer, budget, or frequency. An external assistant can supply
hypotheses and a plan, while the engine validates them and enforces evidence rules.

Proposed MCP surface (freeze names and schemas in T01):

| Tool | Purpose | Side effects |
| --- | --- | --- |
| `research_capabilities` | Report configured capabilities and limits without credentials | Read |
| `research_case_create` | Save idea and optional hypotheses | Store write |
| `research_case_get` | Read a case and revision | Read |
| `research_case_update` | Revise a case using an expected revision | Store write |
| `research_plan` | Save a bounded search plan or validate a supplied plan | Store write; optional model call |
| `research_start` | Start an immutable planned run and return its ID promptly | Store write and external calls |
| `research_status` | Return progress, usage, and failures | Read |
| `research_result` | Return paginated assessment/evidence or report text | Read |
| `research_cancel` | Request cancellation of a run | Store write |

All write operations take idempotency keys where replay can create work; the same
key with different input returns a conflict. Reads do not silently trigger paid
work. Results have a schema version and stable error codes. Tool metadata reflects
actual writes and external access; annotations do not replace server validation.
Do not expose shell commands, arbitrary SQL, credentials, or arbitrary file paths.

Initial execution design: one active research run per workspace, enforced across
CLI/MCP processes by an atomic database lease; additional starts return `busy`.
The owner process runs the job in the background, retaining status/results in
SQLite. Lease renewal and owner-loss detection must prevent overlapping writers.
After owner loss, mark the run interrupted; no silent resumption of paid calls.
A fresh explicitly requested run can reuse verified cached steps. CLI waits by
default. HTTP research belongs to the service, not to the requesting connection:
client disconnect or session expiry does not cancel it. Clients reconnect and
poll by run ID. Explicit cancel stops work. On service shutdown, abort adapters
and persist interrupted state. Stdio owner-process exit similarly interrupts
its local work; closing one client of a running HTTP service does not.
Native MCP task extensions are not required for the baseline.

Hard limits: queries, fetched pages, iterations, wall time, and model token caps.
Record actual usage where available; mark unavailable costs unknown. Do not promise
an exact monetary cap without reliable provider pricing/usage enforcement.
Cancellation propagates through search, fetch, and model calls.

Deployment baseline: one service instance and one SQLite database on a persistent
local volume; horizontal replicas and network-shared SQLite are out of scope.
HTTP clients authenticate as the installation owner using a configured bearer
credential over TLS (typically terminated by a reverse proxy). Never place tokens
in query strings or source control. HTTP sessions/run IDs are not credentials.
All protected requests require authentication; reject disallowed Origin/Host
values, bound request bodies, rate-limit calls, and redact logs. Bind to loopback
by default outside an explicit container/proxy deployment. Health endpoints reveal
no configuration or research data. This is a private integration baseline, not
a claim of OAuth/public-directory compatibility.

The server stores ideas on the chosen host. Local/self-hosted ownership does not
prevent selected context from reaching configured model/search providers.

## Delegation rules

- Each task below is an issue-sized unit for one Luna xhigh agent. Model choice
  concerns implementation agents, not the engine's runtime model defaults.
- Freeze contracts first. Agents implement agreed behavior rather than independently
  redesigning the product, schemas, or evidence policy.
- Give each agent the baseline revision, task text, dependency artifacts, allowed
  files, acceptance checks, and non-goals. Use separate branches/worktrees when
  running tasks concurrently; the coordinator integrates dependency order.
- Shared files (`schema.ts`, package manifests/lockfile, docs indexes) have one
  owner at a time. Submit follow-up interface needs to the coordinator.
- No live paid calls, production data migrations, scheduler changes, remote
  publication, or host-specific integrations are required for implementation tests.
- Use synthetic fixtures, mocked providers, and temporary SQLite databases with
  cleanup. Follow `AGENTS.md` and `OPEN_SOURCE_REPO_SAFETY.md`.
- Every handoff lists changes, checks/results, assumptions, remaining limitations,
  and temporary-file cleanup. Never report mocked validation as live validation.

## Task backlog

### T01 — Freeze domain, application, and tool contracts

- Depends on: none. Owner: coordinator; Luna can prepare contract drafts.
- Scope: proposed types, validation rules, error envelope, tool schemas, run
  lifecycle, lease ownership, HTTP authentication and disconnect semantics,
  privacy/data-flow contract, and module ownership map.
- Deliverable: TypeScript contracts and a synthetic end-to-end example; planning
  decisions remain proposals until their behavior is implemented.
- Acceptance: describe missing intake fields, case revision conflicts, idempotency
  replay, unavailable providers, interrupted runs, cancellation, and empty evidence
  without ambiguous outcomes. Coordinator reviews before downstream dispatch.

### T02 — Add additive persistence and repositories

- Depends on: T01. Owns: new tables/migrations and research repositories.
- Scope: cases/revisions, hypotheses, plans, runs/steps, evidence links,
  assessments, and idempotency/lease records. Reuse source IDs and hashes.
- Acceptance: fresh and existing synthetic databases migrate idempotently;
  legacy rows survive unchanged; foreign keys, revision conflicts, duplicate
  requests, and case/run isolation work. No raw provider secrets in persisted data.

### T03 — Introduce explicit application context

- Depends on: T01. Owns: context factory and narrowly required adapter seams.
- Scope: injected DB, paths, clock, logger, providers, cancellation, and limits;
  explicit connection lifetime. Existing CLI globals can remain behind adapters.
- Acceptance: two workspaces in one process stay isolated; importing services
  executes no CLI or network calls; finishing one operation does not close a
  shared server DB. Existing command behavior is preserved.

### T04 — Implement case intake and hypothesis management

- Depends on: T02, T03. Owns: case service and intake validation.
- Scope: create/read/revise cases; supplied hypotheses; optional model-assisted
  decomposition via existing provider-neutral task routing.
- Acceptance: supplied hypotheses work without an LLM; suggested claims are
  labeled; incomplete intake requests clarification; old run snapshots stay fixed
  after an edit; no minimum opportunity score or approval gate.

### T05 — Build bounded research planning

- Depends on: T04. Owns: planner and plan validation.
- Scope: queries for problem language, workarounds, alternatives, and counterevidence;
  hypothesis-to-query mapping, search limits, and outbound query preview.
- Acceptance: a synthetic idea produces both supporting and challenging queries;
  no provider key is needed to validate a supplied plan; excessive budgets and
  stale case revisions are rejected. No complete idea pasted into every query.

### T06 — Implement targeted search adapter

- Depends on: T01, T03. Owns: new search interface and Tavily implementation.
- Scope: bounded targeted search, including Reddit-oriented queries, normalized
  results, cancellation, rate-limit/error classification, and mocked coverage.
- Acceptance: result limits and cancellation hold; missing configuration is explicit;
  snippets remain discovery/context data; failed search is not evidence of no demand.
  Legacy enrichment remains compatible. Review applicable source-access conditions
  before any live collection; do not add blocking bypasses.

### T07 — Retrieve and normalize original sources

- Depends on: T06. Owns: safe source reader and collection coverage records.
- Scope: original public pages from search results, bounded size/time/redirects,
  normalized body, canonical URL, retrieval timestamp, and version hash.
- Acceptance: inaccessible pages remain explicit coverage gaps; only fetched
  originals can supply verified excerpts; private/loopback/link-local destinations
  and redirects to them are blocked, including DNS resolution checks. Untrusted
  page instructions are data. Script execution and arbitrary local paths are absent.
- Boundary: full Reddit comment crawling and authenticated/private pages are deferred.

### T08 — Map evidence to hypotheses

- Depends on: T04, T07. Owns: evidence mapping and provenance integration.
- Scope: supports/contradicts/context classification with source-bound excerpts;
  deduplication and independence accounting; model output validation.
- Acceptance: fabricated/stale quotes and snippet-only proof are rejected; repeated
  posts or multiple insights from one source do not inflate independent support;
  source dependence uncertainty is visible. One quote may relate differently to
  different hypotheses. No raw popularity-to-demand conversion.

### T09 — Produce assessments and next experiments

- Depends on: T08. Owns: assessment and report services.
- Scope: claim-level outcomes, explicit gaps, alternatives, next experiment,
  JSON and Markdown views of the same report model.
- Acceptance: zero evidence yields a useful limited result; conflicting evidence
  remains visible; unavailable collection is distinguished from absence of matches;
  factual conclusions reference evidence IDs. No uncalibrated success probability
  or overall market score. Export paths are controlled by the application.

### T10 — Implement durable run coordination

- Depends on: T02, T03, T05. Owns: run manager, lease and step execution.
- Scope: start/status/cancel, immutable snapshots, idempotency, cross-process lease,
  usage accounting, deadlines, interrupted-run recovery. Initially use fake steps.
- Acceptance: duplicate starts do not repeat external work; different payload with
  the same key conflicts; two processes cannot own an active workspace run;
  cancellation interrupts in-flight adapters; crashes do not leave a perpetual
  running state; HTTP client disconnect leaves service-owned work running, while
  explicit cancellation and service shutdown are handled separately. Cached steps are keyed by case/plan/source/provider versions.
- Review: coordinator reviews concurrency and recovery tests before integration.

### T11 — Wire the bounded research loop

- Depends on: T06–T10. Owns: application orchestration.
- Scope: plan → search → originals → evidence → assessment, with at most a
  configured number of follow-up rounds addressing named evidence gaps.
- Acceptance: stop on cancellation, exhausted limits, or no useful follow-up;
  partial results survive provider failure; every run exposes its stopping reason.
  Evidence policy stays the same across CLI and MCP. Run mocked end-to-end cases.

### T12 — Add hypothesis research CLI

- Depends on: T04, T05, T10; final acceptance after T11.
- Owns: new CLI entrypoints and command registration (coordinate manifest edits).
- Scope: equivalents of case, plan, start, status, result, cancel, plus JSON input
  from stdin to avoid requiring sensitive ideas in shell arguments.
- Acceptance: machine-readable stdout, diagnostics on stderr, stable exit codes;
  SIGINT cancels correctly; legacy commands still work. Exported reports match
  application result data. Cover a complete mocked workflow through the CLI.

### T13 — Implement MCP transports: Streamable HTTP and stdio

- Depends on: T01, T03; can develop against fake services. Final acceptance after T11.
- Owns: `mcp/`, protocol tests, SDK dependency and lockfile changes.
- Scope: agreed tools, validated inputs/outputs, capability reporting, pagination,
  error mapping, accurate tool annotations, HTTP lifecycle, and a thin stdio adapter
  with protocol-only stdout. Keep authentication in the middleware owned by T18.
- Acceptance: official SDK client initializes, lists, and calls tools in a real
  child process and over HTTP; reads do not start work; start returns a run ID promptly; status
  remains responsive during research; malformed input and oversized results are
  bounded. Reconnect/poll works without tying the run to a transport session.
  No arbitrary command/SQL/file execution through tool arguments. Do not expose
  the HTTP adapter remotely before T18 security integration is accepted.
- Dependency choice: verify the stable TypeScript SDK release, Node compatibility,
  license, and lock the selected version during implementation. Do not mix v1/v2 APIs.

### T14 — Verify agent workflow integration

- Depends on: T11–T13, T18, T19. Owns: cross-interface integration tests and synthetic examples.
- Scope: assistant creates case, plans, starts, polls, reads evidence, revises case,
  and cancels; CLI and MCP can inspect the same workspace results.
- Acceptance: equivalent fixtures have equivalent assessments through both adapters;
  server restart exposes interrupted work; HTTP disconnect preserves the run,
  reconnect retrieves it, and stdio process shutdown releases owned handles;
  invalid credentials fail closed; no secrets/raw ideas appear in routine diagnostic logs. Include
  injection-bearing source text and attempts to exceed budgets or access other paths.

### T15 — Build usefulness evaluation harness

- Depends on: T01 for rubric; T09/T11 for full execution.
- Owns: synthetic evaluation cases, frozen expected behaviors, evaluation runner.
- Scope: 12–20 cases covering support, opposition, mixed evidence, no evidence,
  inaccessible originals, promotion, duplicates, misleading snippets, and ambiguous
  buyer identity. Keep tuning and holdout cases separate.
- Acceptance: report provenance errors, unsupported conclusions, missed known
  counterevidence, coverage classification, runtime, and available usage. Do not
  claim synthetic performance establishes real-world demand or user usefulness.
- Review: freeze rubric before tuning; coordinator reviews holdout expectations.

### T16 — Documentation, packaging, and release verification

- Depends on: T14, T15. Owns: README, CLI/config guides, MCP guide, implemented ADRs.
- Scope: reproducible local and container launch, HTTP and stdio client configuration, architecture/data
  flow, configured-provider requirements, budgets, interruption behavior, and limits.
- Acceptance: clean install and `npm run verify` pass; documented CLI and MCP
  smoke checks pass with synthetic data; SDK/Node/native-SQLite compatibility is
  documented; dependency licenses and public-repository safety reviewed.
  No claim that ideas never leave the device; no maintainer-specific host config.

### T17 — Run a separately scoped live product pilot

- Depends on: T16. Owner: coordinator with human participants, not an autonomous
  code-only task. Prepare protocol first; live spending/data use need explicit scope.
- Scope: 5–10 consenting users, comparison with normal chat research under a
  comparable budget, private feedback and reproducible measurement procedure.
- Metrics: useful original sources, unsupported claims, counterevidence, time/cost,
  change to hypothesis or next action, willingness to reuse.
- Proposed go/no-go: zero fabricated quotations in reviewed reports; at least
  60% of participants identify a concrete decision/experiment changed by the result;
  at least 50% prefer it to their baseline. Pre-register these provisional targets
  and budget before recruitment; small-sample results are directional, not proof.
- Acceptance: document anonymized aggregate conclusions and a continue/change/stop
  recommendation. Do not commit ideas, interviews, collected content, or identities.

### T18 — Secure the single-owner HTTP service

- Depends on: T01, T03; integrate with T13 before T14.
- Owns: HTTP authentication/security middleware and configuration validation.
- Scope: owner credential authentication, Origin/Host validation, TLS/proxy trust
  configuration, body/rate limits, response/log redaction, and safe bind defaults.
- Acceptance: unauthenticated, invalid-token, and expired/revoked credential cases
  fail closed; sessions and run IDs cannot bypass auth; disallowed origins/hosts
  fail; spoofed forwarded headers are not trusted by default. Health responses
  expose no private data. Test safe token rotation and every protected route.
- Boundary: one owner with trusted clients; no tenant model or public OAuth flow.
  Coordinator reviews the trust boundary before any remote deployment.

### T19 — Package a self-hostable service

- Depends on: T10, T13, T18. Owns: container/build assets and deployment smoke tests.
- Scope: reproducible build, non-root container, persistent SQLite/artifact volume,
  environment/secret configuration, health/readiness, graceful shutdown, and a
  generic TLS reverse-proxy example. No real infrastructure values.
- Acceptance: start a fresh container, authenticate, run a mocked research job,
  disconnect/reconnect, restart, and retrieve persisted state; new requests are
  rejected during shutdown; interrupted work is not silently repeated. Document
  backup/restore and test restore with synthetic data. No credential or runtime
  content is baked into images. One instance per local persistent database.
- Boundary: provide deployable assets and verification only; actual host deployment
  and paid provider calls require a separately authorized execution scope.

## Sequencing and parallel work

| Wave | Tasks | Integration checkpoint |
| --- | --- | --- |
| 0 | T01 | Contracts reviewed and frozen |
| 1 | T02, T03, T15 rubric preparation | Persistence/context ready |
| 2 | T04, T06, T13 against fake services | Intake and adapter contracts verified |
| 3 | T05, T07, T18; continue T13 | Plans and original-source collection ready |
| 4 | T08, T10 | Evidence and run safety reviewed |
| 5 | T09, T12 against services | Report and CLI contracts verified |
| 6 | T11, finish T12/T13, finish T15 | Full mocked workflow operational |
| 7 | T19, then T14, then T16 | Self-hostable release candidate with CLI + HTTP/stdio MCP |
| 8 | T17 | Evidence for next product investment |

Use at most three implementation agents plus a coordinator. Parallel tasks must
have disjoint file ownership; integration and shared manifest edits are serialized.
Task completion means accepted artifacts, not merely an agent's final message.

Milestones:

- M1: contracts, persistence, intake, and research plan (T01–T05).
- M2: bounded evidence-backed research (T06–T11).
- M3: required CLI/MCP delivery, HTTP security, deployable packaging, and verified
  agent workflow (T12–T16, T18–T19).
- M4: live product usefulness decision (T17).

Do not attach calendar promises to model task counts. Re-estimate after T01 and
after the first original-source retrieval spike; source access is the largest
external uncertainty.

## Issue conversion and delegation template

Published planning baseline: [epic #8](https://github.com/bknstn/idea-maze-engine/issues/8).
The checklist below records the original backlog. Implementation progress is
tracked separately; an unchecked item here does not establish its current status.
Issue #7 remains open as deferred public-UI context.

- [ ] [T01: Freeze domain, application, and tool contracts](https://github.com/bknstn/idea-maze-engine/issues/9)
- [ ] [T02: Add additive persistence and repositories](https://github.com/bknstn/idea-maze-engine/issues/10)
- [ ] [T03: Introduce explicit application context](https://github.com/bknstn/idea-maze-engine/issues/11)
- [ ] [T04: Implement case intake and hypothesis management](https://github.com/bknstn/idea-maze-engine/issues/12)
- [ ] [T05: Build bounded research planning](https://github.com/bknstn/idea-maze-engine/issues/13)
- [ ] [T06: Implement targeted search adapter](https://github.com/bknstn/idea-maze-engine/issues/14)
- [ ] [T07: Retrieve and normalize original sources](https://github.com/bknstn/idea-maze-engine/issues/15)
- [ ] [T08: Map evidence to hypotheses](https://github.com/bknstn/idea-maze-engine/issues/16)
- [ ] [T09: Produce assessments and next experiments](https://github.com/bknstn/idea-maze-engine/issues/17)
- [ ] [T10: Implement durable run coordination](https://github.com/bknstn/idea-maze-engine/issues/18)
- [ ] [T11: Wire the bounded research loop](https://github.com/bknstn/idea-maze-engine/issues/19)
- [ ] [T12: Add hypothesis research CLI](https://github.com/bknstn/idea-maze-engine/issues/20)
- [ ] [T13: Implement MCP transports: Streamable HTTP and stdio](https://github.com/bknstn/idea-maze-engine/issues/21)
- [ ] [T14: Verify agent workflow integration](https://github.com/bknstn/idea-maze-engine/issues/22)
- [ ] [T15: Build usefulness evaluation harness](https://github.com/bknstn/idea-maze-engine/issues/23)
- [ ] [T16: Documentation, packaging, and release verification](https://github.com/bknstn/idea-maze-engine/issues/24)
- [ ] [T17: Run a separately scoped live product pilot](https://github.com/bknstn/idea-maze-engine/issues/25)
- [ ] [T18: Secure the single-owner HTTP service](https://github.com/bknstn/idea-maze-engine/issues/26)
- [ ] [T19: Package a self-hostable service](https://github.com/bknstn/idea-maze-engine/issues/27)

```text
Only after explicit authorization to start development:
Implement Txx from docs/proposals/hypothesis-research-mcp-plan.md.
Baseline revision: <revision>. Accepted dependencies: <issues/artifacts>.
Model: Luna; reasoning: xhigh.
Owned files: <explicit list agreed by coordinator>.
Implement only the task scope and acceptance criteria.
Read AGENTS.md and OPEN_SOURCE_REPO_SAFETY.md first.
Reuse frozen contracts; report contract changes before editing shared interfaces.
Use synthetic isolated data and mocked providers. No live paid runs or publication.
Return: changed files, verification commands/results, limitations, and cleanup.
```

## Protocol references checked for this plan

- [TypeScript SDK stdio serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)
- [SDK packages and entry points](https://ts.sdk.modelcontextprotocol.io/v2/get-started/packages)
- [SDK client connection](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)

These support the local adapter and integration-test approach. Recheck SDK and
client compatibility when T13 starts; this plan does not pin an untested dependency.
