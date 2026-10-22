# ADR 0003: Calibrate review against source quality

- Status: Accepted
- Adopted: 2026-06-14
- Recorded retrospectively: 2026-10-22

## Context

Human rejection exposed a gap between valid-looking research and useful
opportunities: promotional sources, weak willingness to pay, unrelated source
clusters, and repeated search results could inflate confidence.

## Decision

Tighten deterministic evidence calibration and use quality-adjusted automation
scores. Distinguish primary buyer evidence from search context. Expose review
quality diagnostics so filtering can be inspected rather than inferred from a
raw market score.

## Consequences

The automated funnel becomes more selective. This decision implemented a subset
of the broader June calibration proposal; it does not claim that every proposed
source expansion or reporting feature shipped. Later thesis-alignment checks
are recorded in ADR 0007.

## Implementation history

- [Evidence calibration and diagnostics (`ecadce2`)](https://github.com/bknstn/idea-maze-engine/commit/ecadce2)
