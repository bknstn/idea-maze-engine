# ADR 0009: Inspect artifact retention without deleting files

- Status: Accepted
- Adopted: 2026-08-09
- Recorded retrospectively: 2026-10-22

## Context

Archived opportunities can leave old research and exploration files on disk.
Operators need visibility before choosing any cleanup policy.

## Decision

Add a retention inspection covering both artifact kinds. Report old files for
archived opportunities while excluding approved opportunities. Include the
inspection in the pipeline without automatically deleting files or records.

## Consequences

Retention reporting is read-only and has a configurable age threshold. Actual
deletion remains a separate operator action; running the pipeline does not
silently erase research output.

## Implementation history

- [Retention reporting and tests (`0564e47`)](https://github.com/bknstn/idea-maze-engine/commit/0564e47)
