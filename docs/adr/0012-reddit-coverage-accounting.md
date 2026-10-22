# ADR 0012: Track Reddit ingestion ranges and coverage gaps

- Status: Accepted
- Adopted: 2026-09-25
- Recorded retrospectively: 2026-10-22

## Context

Fetch counts alone cannot distinguish unchanged feeds, missing historical
ranges, failed requests, or deferred communities.

## Decision

Persist per-community requested and observed ranges, cursors, successful checks,
coverage gaps, and failure classes. Bound request time, retries, and total run
budget. Write raw records atomically and expose coverage diagnostics.

## Consequences

Reports distinguish source discovery from successful coverage checks. Partial
RSS windows and rate limits remain visible limitations. Scheduling advice is
provisional because there is no independent complete post inventory.

## Implementation history

- [Coverage accounting and ingestion tests (`6264704`)](https://github.com/bknstn/idea-maze-engine/commit/6264704)
