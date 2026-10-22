# ADR 0000: Local CLI and SQLite pipeline

- Status: Accepted
- Adopted: 2026-05-14
- Recorded retrospectively: 2026-10-22

## Context

Product discovery needs a persistent connection between collected material,
extracted signals, candidate ideas, research, and review feedback.

## Decision

Use a TypeScript CLI backed by one local SQLite database. Separate ingestion,
extraction, opportunity refresh, and processing into independently callable
stages. Keep source material and generated output under an ignored data root;
use run records and events to make processing inspectable.

## Consequences

The engine can run locally or under an external scheduler without a hosted
application. Database schema and runtime state are shared across stages, so
commands must use the same data root. This introduces native SQLite dependencies
and requires care when backing up a database using WAL.

## Implementation history

- [Initial engine (`dcf59bb`)](https://github.com/bknstn/idea-maze-engine/commit/dcf59bb)
- [Package structure (`9db1ee6`)](https://github.com/bknstn/idea-maze-engine/commit/9db1ee6)
- [Data directory initialization (`a36aca0`)](https://github.com/bknstn/idea-maze-engine/commit/a36aca0)
- [Ignore runtime data (`b63228d`)](https://github.com/bknstn/idea-maze-engine/commit/b63228d)
