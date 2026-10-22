# ADR 0004: Explore approved opportunities separately

- Status: Accepted
- Adopted: 2026-06-21
- Recorded retrospectively: 2026-10-22

## Context

A reviewed idea needs a next step: customer hypotheses, experiments, interviews,
and kill criteria. Deeper exploration must not overwrite a human decision or
be confused with initial research publication.

## Decision

Add a dedicated exploration run type and Markdown output for active, approved
opportunities. Support both engine-owned model generation and a prepare/finalize
JSON handoff for external generation. Validate the brief before finalization;
record failures as requiring manual exploration.

## Consequences

Exploration has separate records and output under data/explorations. It preserves
approval/rejection state. External callers can bring their own generation flow,
but must return the declared schema. A force option explicitly bypasses the
normal eligibility guard.

## Implementation history

- [Exploration stage, storage, and CLI (`f7e015b`)](https://github.com/bknstn/idea-maze-engine/commit/f7e015b)
