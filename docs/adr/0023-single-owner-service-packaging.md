# ADR 0023: Package the single-owner service with a loopback TLS sidecar

- Status: Accepted
- Adopted: 2026-10-29

## Context

A self-hosted service needs reproducible runtime dependencies, private persistent
storage, controlled network exposure, and a tested restoration path. The existing
HTTP policy intentionally permits loopback binds only.

## Decision

Build the MCP entrypoint from the lockfile on a digest-pinned Node 22 image.
Bundle application modules while leaving runtime packages external, including
native SQLite bindings and dependency license files. Include the project's MIT
notice. Run the application as UID/GID 10001 with a read-only root filesystem
and explicit workspace/backup mounts. Exclude credentials and runtime content
from the build context.

Keep the HTTP listener on loopback. A digest-pinned Nginx TLS sidecar shares the
application's network namespace, with the proxy port published by the namespace
owner. Trust only the explicitly configured proxy peer and forwarded protocol
header. Credentials stay in private environment/secret configuration.

Use SQLite's online backup API and a database SHA-256 manifest. Copy artifacts
without following symlinks; the manifest counts artifact files but does not hash
their contents. Quiesce writes for a consistent database-and-artifact snapshot.
Restore only into an empty workspace, rejecting pre-existing database, WAL/SHM
sidecars and artifacts. Validate the database with SQLite before installation.

## Consequences

One service instance owns each local persistent workspace. CLI reads remain
available through the shared database; horizontal replicas and network storage
are outside this design. Operators must grant the container UID access to its
mounts and manage TLS material, secrets and backups privately.

The normal verification command includes synthetic backup/restore regression
checks. Container smoke is a separate explicit command requiring Docker, Compose,
OpenSSL and access to pinned images. It mounts offline provider fixtures outside
the production image and checks authentication, reconnect, shutdown, restart and
restoration. Local provider/lifecycle tests do not establish a live deployment
or human research usefulness. See the release verification record for the exact
checks executed and any remaining environment limitations.

## Implementation references

- `Dockerfile`, `.dockerignore`, and `deploy/compose.yaml`
- `deploy/nginx.conf` and the empty configuration examples
- `deploy/data-transfer.mjs`, its tests, and `deploy/smoke-test.mjs`
- `docs/guides/self-hosting.md`
- [Service packaging task](https://github.com/bknstn/idea-maze-engine/issues/27)
