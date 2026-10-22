# ADR 0008: Rotate Reddit harvest work across runs

- Status: Accepted
- Adopted: 2026-08-02
- Recorded retrospectively: 2026-10-22

## Context

A bounded ingestion run should eventually visit every configured community,
rather than repeatedly selecting only the first group.

## Decision

Persist the harvest cursor and rotate bounded subreddit batches across runs.
Keep deterministic batch-selection tests. A subsequent ingestion repair uses
Reddit RSS feeds; newer coverage accounting is described in ADR 0012.

## Consequences

Per-run work is bounded while repeated runs visit the configured list. Rotation
alone cannot guarantee complete coverage, especially when RSS history is
limited or a community is unavailable.

## Implementation history

- [Rotate harvest shards (`65e2967`)](https://github.com/bknstn/idea-maze-engine/commit/65e2967)
- [Restore RSS ingestion (`df6eedb`)](https://github.com/bknstn/idea-maze-engine/commit/df6eedb)
