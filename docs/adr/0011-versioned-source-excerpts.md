# ADR 0011: Verify source excerpts against visible body windows

- Status: Accepted
- Adopted: 2026-09-24
- Recorded retrospectively: 2026-10-22

## Context

Normalized substring matching against a full title/body could accept quotes
that were not shown to the extractor, came only from the title, lost meaningful
punctuation, or belonged to an earlier source version.

## Decision

Use bounded head/middle/tail body windows and verify excerpts against exact
source ranges, current source identity, and content hash. Treat invalid or stale
excerpts as unverified. Provide an opt-in legacy metadata backfill and a
deterministic synthetic evaluation with separate tuning and holdout fixtures.

## Consequences

Evidence support becomes inspectable and tied to source versions. Backfill
cannot recover unseen text and does not make model calls. Synthetic contract
accuracy does not establish real-world discovery quality or buyer demand.

## Implementation history

- [Grounded source excerpts (`52984a2`)](https://github.com/bknstn/idea-maze-engine/commit/52984a2)
- [Synthetic evaluation (`6fc49ef`)](https://github.com/bknstn/idea-maze-engine/commit/6fc49ef)
