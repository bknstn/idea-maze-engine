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
| T18 / #26 | Mandatory owner HTTP policy, auth/rotation/revocation, Host/Origin/proxy/rate/body checks |
| T13 / #21 | Protocol/auth phase accepted with official SDK against fake app; real application wiring pending T11 |
| T15 / #23 | Rubric and 18 synthetic fixtures accepted; real-path evaluation runner pending T09/T11 |
| T09 / #17 | Published with this checkpoint: verified claim assessments and bounded JSON/Markdown result pages |
| T10 / #18 | Luna implementation in a separate managed worktree; concurrency/recovery review pending |
| T11 / #19, T12 / #20 | Research orchestration and CLI remain pending |
| T19 / #27, T14 / #22, T16 / #24 | Packaging, cross-interface integration, release docs/checks pending |
| T17 / #25 | Separately scoped human pilot; participants and explicit data/spend scope still required |

## Verification

Latest integrated check: `npm run verify` passed TypeScript and **46 test files /
363 tests**. Spawned-process and loopback SDK tests require local IPC/socket
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
acceptance and publishes a separate commit per completed issue. Finish #18,
then #19, finish #20/#21 and #23, package #27, verify #22, and complete #24.
Preserve the separate pilot scope for #25.
Shared files have one owner at a time; report interface requests before editing.

T09 enforces a 448 KiB duplicated MCP result budget and 30,000 Markdown
characters. Oversized repeated reports fail safely; no evidence is silently
dropped. The evaluation runner must map
logical fixture IDs to generated runtime IDs by provenance. Freeze tuning before
inspecting holdout results; do not tune against the holdout. The corpus digest is
`13b7ccf965043c8dec05f7189b057308c996de9bd01171fb25dfd141bf517c26`.

No temporary helper scripts were created. Test-created databases/directories are
cleaned by their fixtures. The T10 managed worktree remains active until integration;
remove task-created dependency symlinks and archive it after verification.
