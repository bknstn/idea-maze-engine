# ADR 0005: Keep artifacts local without repository mirroring

- Status: Accepted
- Adopted: 2026-06-21
- Recorded retrospectively: 2026-10-22

## Context

Research files were local outputs, while a separate repository export queue and
host wakeup mechanism added a second publication concern.

## Decision

Remove artifact repository mirroring, export configuration, export queue writes,
and IPC wakeups. Keep local artifact publication, artifact records, and CLI
listing. Preserve existing runtime files and legacy database contents rather
than performing destructive cleanup.

## Consequences

The engine no longer publishes research into a second Git repository. Operators
choose how to share local Markdown. Old export-related database state may remain
in previously created databases but is no longer an active workflow.

## Implementation history

- [Remove mirroring and export behavior (`f3ec136`)](https://github.com/bknstn/idea-maze-engine/commit/f3ec136)
