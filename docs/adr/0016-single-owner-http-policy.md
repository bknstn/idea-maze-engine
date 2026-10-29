# ADR 0016: Require an explicit single-owner HTTP policy

- Status: Accepted
- Adopted: 2026-10-29

## Context

The research MCP service can expose stored ideas and paid operations. A session
or run identifier cannot authorize access, and a local bind alone does not
protect against browser requests or an incorrectly configured reverse proxy.

## Decision

Require a validated owner policy before opening the Streamable HTTP adapter.
Authenticate every protected request using a bearer credential configured
outside tool inputs. Store credential digests in memory, with explicit expiry,
replacement, overlap, and revocation. Health responses contain only a minimal
status and still pass Host, Origin, and rate checks.

Bind the adapter to loopback. Validate exact Host/Origin policy, reject duplicate
security headers, bound headers and bodies, and rate-limit requests. Trust only
explicit proxy peers with exactly the accepted HTTPS forwarding header; reject
other forwarding claims. Container/proxy topology is separate packaging work.

Snapshot application and policy references when opening the service. Each HTTP
request has its own stateless protocol transport while the application owns
research work. Client disconnect does not cancel that work. Explicit shutdown
rejects new requests, aborts the application, and closes connections within a
bounded drain period.

## Consequences

The service is a private single-owner integration, without a public OAuth or
multi-tenant distribution claim. Credential rotation applies to subsequent
requests without restarting. A deployment must provide TLS and a compatible
proxy topology. Official SDK tests use synthetic applications and loopback
sockets; they do not validate a deployed host.

## Implementation references

- `src/idea-maze/mcp/security/` and its tests
- `src/idea-maze/mcp/transports/streamable-http.ts`
- `src/idea-maze/mcp/transport.test.ts`
- [HTTP security task](https://github.com/bknstn/idea-maze-engine/issues/26)
