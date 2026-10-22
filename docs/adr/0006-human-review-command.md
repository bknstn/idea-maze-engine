# ADR 0006: First-class CLI review with rejection reasons

- Status: Accepted
- Adopted: 2026-07-06
- Recorded retrospectively: 2026-10-22

## Context

Review feedback needed a stable interface so approvals, rejection reasons, and
notes could be applied consistently without manual SQL edits.

## Decision

Add idea:review for research run IDs with approval/rejection, repeated or
comma-separated reason labels, optional notes, and JSON output. Apply approval
records, lifecycle changes, feedback features, and run events transactionally.
Account for prior publication feedback when reversing a decision.

## Consequences

Review decisions become auditable and available to scoring and duplicate checks.
Callers must use accepted reason labels. The public preparation pass later
replaces the owner-specific default reviewer with the neutral actor user;
explicit library-provided reviewer identities remain supported.

## Implementation history

- [Human review CLI (`23c9b87`)](https://github.com/bknstn/idea-maze-engine/commit/23c9b87)
