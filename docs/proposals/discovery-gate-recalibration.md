# Discovery-gate recalibration

- Status: Historical proposal; not implemented
- Proposed: 2026-09-01
- Archived: 2026-09-27
- Source: [archive commit 0089756](https://github.com/bknstn/idea-maze-engine/commit/0089756)

## Problem

Stricter evidence alignment can leave the discovery funnel with few reviewable
candidates. This raises a precision/recall question: incomplete evidence may
need further collection rather than terminal rejection.

## Proposed direction

- Separate terminal rejection from a re-evaluable needs-more-evidence outcome.
- Keep deterministic evidence checks, while considering model alignment as
  advisory except for grounded contradictions.
- Calibrate thresholds with an offline historical shadow backtest before any
  policy change or controlled live validation.
- Report funnel outcomes, source independence, rejection reasons, and recall
  limitations rather than optimizing only for candidate volume.

## Adoption criteria

Implementation would need explicit policy tests, an offline comparison of old
and proposed behavior, duplicate/promotion safeguards, and reviewed evidence
that increased throughput produces useful candidates. Scheduler decisions and
live dataset changes require their own operational review.

This proposal does not enable a scheduler, relax current gates, or establish a
measured target approval rate. Current evidence alignment remains documented
in [ADR 0007](../adr/0007-thesis-aligned-source-evidence.md).
