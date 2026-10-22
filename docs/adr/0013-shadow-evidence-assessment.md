# ADR 0013: Optional shadow evidence assessment

- Status: Accepted
- Adopted: 2026-09-25
- Recorded retrospectively: 2026-10-22

## Context

An additional evidence assessor can supply diagnostics, but experimental
assessments should not alter established source selection, drafts, or gates.

## Decision

Add an opt-in TypeSafe/Jev assessor on the research evidence path. Require an
enable flag, API key, and explicit account-supported model. Assess only eligible
original sources with currently verified excerpts; exclude search-discovery
sources. Keep scores diagnostic and preserve the normal research outcome.

## Consequences

The cache key covers the source version, opportunity, verified excerpts,
questions, rubric, and model. Cache values retain hashes, dimensions, usage,
and timings without copying raw source text. Trace cache hits, unknowns,
errors, models, and latency. Apply bounded deadlines and input budgets with no
automatic retries. Provider behavior is tested with mocks; live account
validation is not claimed.

## Implementation history

- [Optional shadow assessor and research integration (`73d7c82`)](https://github.com/bknstn/idea-maze-engine/commit/73d7c82)
