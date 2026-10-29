# ADR 0022: Verify one research workflow across CLI and MCP

- Status: Accepted
- Adopted: 2026-10-29

## Context

Separate adapter tests do not establish that clients can exchange case/run IDs,
read the same persisted evidence, or obtain equivalent nonempty assessments.

## Decision

Exercise the real application with isolated synthetic providers through the CLI
dispatcher and official HTTP SDK client. Compare mixed and contradicted results
without comparing generated IDs. Read persisted results with the real CLI
process and a stdio SDK child, then reopen the workspace after shutdown.

Verify that case revision changes leave earlier run snapshots unchanged, HTTP
disconnect leaves work owned by the service, and explicit cross-interface cancel
stops it. Reject extra path arguments and excessive budgets. Keep instruction-like
source content in labeled untrusted fields and check routine diagnostics for
synthetic private-data markers. Startup with malformed credentials fails before
creating database state. Existing lifecycle/security tests retain interruption,
EOF cleanup, credential and transport-boundary coverage.

## Consequences

These tests establish adapter parity and persistence/lifecycle behavior with
purpose-built provider doubles. They do not establish model resistance to arbitrary
injection or research usefulness. Container deployment checks remain owned by
the packaging task; live deployment and the human pilot remain separate scopes.

## Implementation references

- `src/idea-maze/research/workflow-integration.test.ts`
- `src/idea-maze/research/fixtures/workflow-providers.ts`
- `src/idea-maze/mcp/runtime.test.ts`
- `docs/examples/hypothesis-research-workflow.md`
- [Workflow integration task](https://github.com/bknstn/idea-maze-engine/issues/22)
