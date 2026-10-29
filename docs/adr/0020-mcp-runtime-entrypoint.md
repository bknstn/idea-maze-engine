# ADR 0020: Bind MCP transports to the real research runtime

- Status: Accepted
- Adopted: 2026-10-29

## Context

Protocol adapters verified against synthetic application ports need a runnable
entrypoint and integration checks against the actual shared application.

## Decision

Use one import-safe executable to construct the shared runtime and select HTTP
by default or stdio explicitly. Validate owner HTTP configuration before opening
the database. Credentials have an explicit future expiry and are supplied through
environment/secret configuration; Host, Origin, proxy, body, and rate settings
remain bounded by the validated security policy.

Keep protocol stdout clean and document silent npm invocation for stdio.
HTTP disconnect leaves service-owned research running. Process signals and
stdio EOF drain the runtime and remove process signal listeners, including an
EOF race during startup. Shutdown failures emit only generic diagnostics.

## Consequences

Both transports use the same application, database ownership, budgets, and result
rules as CLI. Official SDK integration tests exercise the real runtime with
synthetic providers and isolated storage. They establish local protocol/lifecycle
behavior, not deployed-host compatibility or live research usefulness. Container
packaging and cross-interface release verification remain separate tasks.

## Implementation references

- `src/idea-maze/scripts/research-mcp.ts`
- `src/idea-maze/mcp/security/http-config.ts` and its tests
- `src/idea-maze/mcp/runtime.test.ts`
- `docs/guides/hypothesis-research-mcp.md`
- [MCP transport task](https://github.com/bknstn/idea-maze-engine/issues/21)
