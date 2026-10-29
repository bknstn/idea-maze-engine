# Hypothesis research implementation checkpoint

Execution authorized on 2026-10-28. Baseline: `a3afdfa3679ced5deb7b7b8a2f1549f32e4a466e`.

Accepted work is being reviewed and published in separate commits per issue.
Existing proposal/index edits were preserved. No live provider calls, spending,
deployment, real participant data, or pilot occurred. Published implementation
is distinct from an integrated release; partial tasks remain open on GitHub.

## Accepted and pending work

| Task / issue | Status |
| --- | --- |
| T01 / #9 | Published `206ff8e`: Contracts accepted and frozen, including reviewed T08 refinement |
| T02 / #10 | Published `571042b`: Additive SQLite persistence, revisions, provenance, idempotency, fenced leases |
| T03 / #11 | Published `976c63d`: Explicit context, providers, paths, DB ownership and cancellation |
| T04 / #12 | Published `e7aa438`: Case intake/read/revise, hypothesis provenance and local replay |
| T05 / #13 | Published `4c5406e`: Bounded deterministic planning and durable optional model suggestions |
| T06 / #14 | Published `00807e3`: Bounded cancellable Tavily adapter; exact planned outbound query |
| T07 / #15 | Published `d043c1e`: DNS-pinned static public-original retrieval and normalization |
| T08 / #16 | Published `57cd579`: Verified candidate mapping, exact provenance, source grouping and uncertainty |
| T18 / #26 | Published `f191dfb`: mandatory owner HTTP policy, auth/rotation/revocation, Host/Origin/proxy/rate/body checks |
| T13 / #21 | Published `89d8714`: HTTP/stdio MCP entrypoint and official SDK checks against the actual runtime with mocked providers |
| T15 / #23 | Published `c547c0d`: frozen 18-fixture corpus and real-path offline evaluator; first reports retain semantic mismatches and one harness planning failure |
| T09 / #17 | Published `bdb7430`: verified claim assessments and bounded JSON/Markdown result pages |
| T10 / #18 | Published `9d0450b`: durable coordination, fenced recovery, bounded cancellation and conservative usage accounting |
| T11 / #19 | Published `9fdee9a`: shared application/runtime, bounded collection, verified classification and explicit coverage |
| T12 / #20 | Published `57123c6`: stdin JSON CLI and process entrypoint; 33 CLI regressions, including actual runtime workflow |
| T14 / #22 | Published `bca860c`: nonempty CLI/HTTP parity, shared workspace process reads, revision/cancel/diagnostic checks |
| T19 / #27 | Packaging assets published with this checkpoint; standard container CI acceptance pending |
| T16 / #24 | Release docs and clean-install verification prepared; final packaging/CI gate pending |
| T17 / #25 | [Pilot protocol prepared](hypothesis-research-pilot-protocol.md); consenting participants and explicit data/spend scope still required |

## Verification

Latest integrated check: `npm run verify` passed TypeScript and **55 test files /
453 tests**, plus **3 deployment backup/restore tests**. Spawned-process and loopback SDK tests require local IPC/socket
permission outside the restricted sandbox. Mocked providers and synthetic SQLite
fixtures are not live research or product-usefulness validation.

New SDK dependencies are pinned: runtime `@modelcontextprotocol/server@2.4.0`
and `@modelcontextprotocol/node@2.1.2`; dev `@modelcontextprotocol/client@2.4.0`.
Node >=20 and added Apache-2.0/MIT/ISC licenses were checked. Existing lockfile
platform/libc metadata was preserved. No runtime model defaults were changed.

## Decisions to retain

- CLI and MCP use the same explicit application services. Run execution state is
  separate from assessment outcome; completed research may be insufficient.
- Case/hypothesis revisions and run snapshots are immutable. Drafts return missing
  intake fields; no legacy discovery score or approval gates apply.
- SQLite schema v2 includes durable planning reservations: pending, completed or
  unknown. Identical keys wait/replay; mismatched payloads conflict. Expired or
  aborted external work is never automatically repeated. Provider I/O stays
  outside SQLite transactions; observed usage remains nullable and sanitized.
- One run per workspace uses an atomic, monotonically fenced lease. A stale owner
  cannot commit state; an already submitted remote request may outlive local abort.
- Quote provenance uses immutable fetched text, hash and exact UTF-16 range.
  Research role `claim` preserves generic statements without changing legacy
  excerpt roles. Snippets never prove claims. Classification is an interpretation.
- Source-group reports must be recomputed over all run evidence after follow-ups.
  Different URLs do not confirm independent authorship; uncertainty stays explicit.
- HTTP client disconnect does not cancel service-owned work. Explicit service
  shutdown gates requests and aborts work before bounded connection cleanup.
- HTTP requires a branded validated owner policy. Only exact GET/HEAD `/healthz`
  skips bearer auth. Direct bind remains loopback; same-host TLS proxy trust needs
  an explicit peer plus exactly `X-Forwarded-Proto: https`. Other forwarded headers
  are rejected. T19 must resolve/review container and proxy network topology.

## Resume instructions

Read this checkpoint, the contract proposal and repository safety instructions.
Use fresh Luna xhigh implementation agents; the coordinator reviews before
acceptance and publishes a separate commit per completed issue. Finish packaging #27 and complete #24.
Preserve the separate pilot scope for #25.
Shared files have one owner at a time; report interface requests before editing.

T10 review verified provider and executor abort races, monotonic cancellation,
terminal-only lease release, expiry recovery, atomic model-budget reservations,
and unknown token/cost totals for interrupted in-flight work. It exposes a
lease-fenced synchronous `withWrite` hook for T11's incremental source/evidence
persistence. Cache keys/eligibility exist; automatic cache replay does not.

T11 owns `createResearchApplication(context, options?)` and the synchronous
`createResearchRuntime(options?)` factory returning context, application, and
async shutdown. CLI/MCP must use that factory. Follow-ups use unused previewed
queries and named gaps; assessment is saved once after the bounded collection.
T11 marks research originals for exclusion from legacy extraction.
The generic LLM task seam must enforce input/output admission and cancellation
behind registered adapters, preserving legacy model defaults.

T09 enforces a 448 KiB duplicated MCP result budget and 30,000 Markdown
characters. Oversized repeated reports fail safely; no evidence is silently
dropped. The evaluation runner must map
logical fixture IDs to generated runtime IDs by provenance. Freeze tuning before
inspecting holdout results; do not tune against the holdout. The corpus digest is
`13b7ccf965043c8dec05f7189b057308c996de9bd01171fb25dfd141bf517c26`.

No temporary helper scripts were created. Test-created databases/directories are
cleaned by their fixtures. T10, T11, and T12 are archived and checkout removal verified.
T13, T14, and T15 are archived and checkout removal verified. T19 helpers,
Docker imports, test state and dependency symlink were removed; its worktree stays
active until the container CI result is reviewed.

The first holdout was run once at evaluator freeze
`220a9bea86bce0d87ba1196e4d948d2c060650a681d1352e8b47663c581a1106`.
See [the full evaluation report](../evaluations/hypothesis-research-v1.md) for
failures, unknown fields and interpretation limits. No implementation was tuned
after observing those outcomes.

Packaging local checks passed SQLite WAL backup/restore, stale-sidecar and
corrupt/symlink refusal. Compose configuration and pinned image content were
verified; local Docker build API stalls prevented the full smoke. The new
container CI job runs the standard pinned path independently. Do not mark #27
complete until that result passes review. Gitleaks 8.30.1 full-history scan
passed after five exact historical fingerprints for synthetic planner
idempotency-key inputs; no broad rule suppression was added.
