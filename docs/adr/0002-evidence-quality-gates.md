# ADR 0002: Evidence quality before automated research

- Status: Accepted
- Adopted: 2026-06-05
- Recorded retrospectively: 2026-10-22

## Context

A high score and a well-formed model response do not establish independent buyer
pain. Template drafts and repeated rejected ideas could otherwise reach review.

## Decision

Add deterministic evidence-quality and rejected-duplicate checks to opportunity
processing. Require direct source support in addition to score thresholds.
Quarantine fallback-template research instead of treating it as a valid draft.
Record human rejection reasons alongside feedback.

## Consequences

Some high-scoring candidates are blocked until better evidence is available.
Schema/prose validity remains distinct from opportunity quality. Gates are
conservative and require diagnostics and later calibration.

## Implementation history

- [Quality filters and review feedback (`7421290`)](https://github.com/bknstn/idea-maze-engine/commit/7421290)
