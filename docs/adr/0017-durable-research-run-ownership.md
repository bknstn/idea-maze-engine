# ADR 0017: Own research runs independently of client connections

- Status: Accepted
- Adopted: 2026-10-29

## Context

CLI and MCP clients can retry or disconnect while research calls remain in
flight. Multiple processes may share the workspace database, and an owner can
crash after submitting a paid request. Retrying work implicitly would risk both
duplicate spending and conflicting writes.

## Decision

Create the immutable run snapshot, acquire its workspace lease, and save the
idempotency receipt in one SQLite transaction. Schedule execution after commit.
Replaying the same validated request returns the original receipt; conflicting
input or an occupied workspace starts no additional work.

Use an expiring, monotonically fenced lease across processes. Renew it while
working, observe durable cancellation, and recheck ownership immediately before
dispatch and after adapter return. Race provider and executor promises against
service-owned cancellation. Permit synchronous fenced writes of completed
chunks during cancellation drain while blocking further external dispatch.

Cancellation is monotonic and terminal statuses cannot regress. Release a lease
only after durable terminalization. If final persistence fails, retain it until
expiry recovery marks the run interrupted. Startup and periodic maintenance
recover expired owners; status reads do not initiate recovery or provider work.
Keep partial evidence and already produced assessments.

Reserve query/page attempts and model-token allowances before external calls.
Refund unused model allowances only from validated reported usage. Unknown
outcomes consume the reservation and keep observed token/cost totals nullable.
Interrupting an unaccounted call cannot report earlier totals as complete usage.

## Consequences

Lease fencing prevents stale writes, not remote request rollback or exactly-once
billing. Crash recovery waits for lease expiry and never silently resumes paid
work. Exact-version cache keys and verified-entry eligibility are available;
automatic cache storage/replay is not implemented. Successfully assessed partial
results retain budget/deadline stopping reasons separately from their outcome.

Synthetic tests cover competing processes, owner crashes, bounded shutdown,
late cancellation, reservations, partial evidence, and failed terminal writes.
They do not perform live provider calls.

## Implementation references

- `src/idea-maze/research/run-manager.ts` and its tests
- `src/idea-maze/research/run-step-executor.ts` and its tests
- `src/idea-maze/research/repositories.ts`
- `src/idea-maze/research/fixtures/run-coordination-worker.ts`
- [Run coordination task](https://github.com/bknstn/idea-maze-engine/issues/18)
