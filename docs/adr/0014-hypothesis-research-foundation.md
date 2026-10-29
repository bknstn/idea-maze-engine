# ADR 0014: Isolate hypothesis research from discovery scoring

- Status: Accepted
- Adopted: 2026-10-29

## Context

Researching a supplied product idea requires explicit hypotheses and revisioned
evidence. The existing discovery pipeline ranks harvested opportunities and has
approval gates that do not fit this workflow. Both workflows must keep their
existing data and behavior.

## Decision

Introduce separate additive SQLite tables and repositories for research cases,
hypothesis revisions, plans, runs, evidence, assessments, idempotency receipts,
and workspace leases. Retain shared source identifiers while storing immutable
original-source versions for exact excerpt verification. Preserve the legacy
opportunity lifecycle and scoring gates.

Use a versioned application contract shared by future CLI and MCP adapters.
Separate execution state from assessment outcome: a completed run may conclude
that evidence is insufficient. Database writes use explicit workspace scope;
run writes require an unexpired, monotonically fenced workspace lease. External
work stays outside SQLite transactions and is not silently retried after an
unknown outcome.

## Consequences

Existing databases migrate without rewriting legacy rows. Case edits append
revisions and cannot change earlier run snapshots. Persistence supplies the
mechanisms for coordination; a runnable service, research loop, transport wiring,
and deployment packaging remain separate integration work.

The repository tests use synthetic data and isolated databases. They verify
revision conflicts, idempotency, source provenance, workspace isolation, and
stale-owner rejection; they do not establish live research usefulness.

## Implementation references

- `src/idea-maze/research/contracts.ts`
- `src/idea-maze/research/migrations.ts`
- `src/idea-maze/research/repositories.ts`
- `src/idea-maze/research/repositories.test.ts`
- `src/idea-maze/scripts/lib/schema.ts`
- [Persistence task](https://github.com/bknstn/idea-maze-engine/issues/10)
