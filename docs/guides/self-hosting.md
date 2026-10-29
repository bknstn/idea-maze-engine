# Self-hosting the Idea Maze MCP service

The packaged service is a single-owner MCP server. Run one service instance
against one local persistent workspace; horizontal replicas and a
network-shared SQLite file are out of scope. Existing local CLI tools can still
use the workspace; the durable run lease coordinates service-owned research.
Do not start a second service container against the same mounted workspace.

The application image is built from the repository lockfile with `npm ci`,
bundles the service entrypoint, and keeps runtime packages external so native
SQLite and package license files remain available. It uses a pinned
multi-platform Node image digest. The separate TLS proxy uses a pinned Nginx
image digest. The application runs as UID/GID `10001`, has a read-only root
filesystem in Compose, and writes only to its workspace and backup mounts.

## Configure and start

From the repository's `deploy/` directory, copy both example files and replace
the placeholders:

```sh
cp compose.env.example .env
cp idea-maze.env.example idea-maze.env
mkdir -p certs state backups
chmod 700 certs
sudo chown -R 10001:10001 state backups
sudo chmod 700 state backups
```

Set `IDEA_MAZE_MCP_BEARER_TOKEN` to a fresh secret generated locally, for
example with `openssl rand -hex 32`, and give it a future explicit expiry in
`IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT`. Keep `idea-maze.env` private. The HTTP
service will not start with an empty, malformed, or expired bearer credential.

Place the TLS certificate and private key at `certs/tls.crt` and
`certs/tls.key`. The bundled Nginx example terminates TLS on port `8443` and
shares the app container's network namespace. This lets Nginx reach the MCP
listener on `127.0.0.1:8787` while the application retains its loopback-only
bind. The app service publishes only the proxy port. The proxy sends the single
trusted header `X-Forwarded-Proto: https`; do not add other forwarded headers
without changing and reviewing the application's proxy policy.

Set `IDEA_MAZE_MCP_ALLOWED_HOSTS` in `idea-maze.env` to the hostname that clients
will send, as a JSON array. For example, a local-only setup can use
`["localhost"]`; remote users should replace it with their own public hostname.
Keep `IDEA_MAZE_MCP_ALLOWED_ORIGINS` empty for non-browser MCP clients. Add only
explicit browser origins if they are needed. `IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS`
should remain `["127.0.0.1"]` for the included shared-network-namespace proxy.

The Compose port publishes on loopback by default. Set `HTTPS_BIND` in `.env`
to the intended host interface only when remote clients need direct access;
keep the service behind TLS and firewall rules. Configure the certificate host,
allowed Host value, and DNS for the same name.

```sh
docker compose --profile proxy config --quiet
docker compose --profile proxy up --build -d --wait
docker compose --profile proxy ps
```

The app healthcheck calls unauthenticated `GET /healthz`. It returns only a
minimal liveness/readiness response and returns an unavailable status while the
service is shutting down. Protected MCP calls at `/mcp` require the bearer
credential. Do not put credentials in URLs, command-line arguments, or source
control. Optional `OPENAI_API_KEY` and `TAVILY_API_KEY` values belong in the
private environment file or an external secret manager. The MCP guide explains
which selected research context may be sent to configured providers.

The mounted `state/` directory contains `data/lab.db` and, when present,
`artifacts/`. Keep this directory on durable local storage and restrict host
permissions to the service owner. If Docker user-namespace remapping changes
the container UID on the host, grant the mapped UID access to these directories.

## Shutdown and recovery

`docker compose stop` sends `SIGTERM` and allows the configured 15-second grace
period. The service stops admitting requests, drains its HTTP transport, and
marks active research runs interrupted before closing SQLite. Client disconnects
do not cancel a run. A restarted service makes persisted state readable but
does not silently repeat interrupted provider work; an owner must start a new
run explicitly.

## Backup and restore

The transfer utility writes a named backup folder under `backups/`. It uses
SQLite's online backup API for a consistent database snapshot and copies the
artifact tree while rejecting symlinks and special files. The database is
SHA-256 checked on restore; the manifest records the artifact file count, not
artifact content hashes. Database snapshotting and artifact copying are separate
operations, so stop the service when a single point-in-time snapshot across both
is required.

To make a quiesced backup:

```sh
docker compose --profile proxy stop idea-maze tls-proxy
docker compose --profile proxy run --rm --no-deps --entrypoint node idea-maze \
  /opt/idea-maze-engine/data-transfer.mjs backup backup-2026-01
docker compose --profile proxy up -d --wait
```

Use a unique backup name made from letters, digits, underscores, and hyphens.
Copy the resulting `backups/backup-2026-01/` directory to secured off-host
storage. Backups contain workspace data and should be protected accordingly;
the environment file and TLS private key are managed separately.

Restore into a new, empty workspace directory. The utility refuses to replace
an existing database, SQLite WAL/SHM sidecar, or artifact directory. Keep the
current `state/` untouched until the restored workspace has been checked.

```sh
docker compose --profile proxy stop idea-maze tls-proxy
mkdir -p state-restored
sudo chown 10001:10001 state-restored
sudo chmod 700 state-restored
IDEA_MAZE_STATE_DIR=./state-restored docker compose --profile proxy run --rm \
  --no-deps --entrypoint node idea-maze \
  /opt/idea-maze-engine/data-transfer.mjs restore backup-2026-01
IDEA_MAZE_STATE_DIR=./state-restored docker compose --profile proxy up -d --wait
```

After verifying the restored MCP state, retain or remove the previous workspace
according to the operator's backup policy. Preserve the backup until the restore
has been checked.

## Packaging checks

`node --test deploy/data-transfer.test.mjs` exercises synthetic WAL snapshots,
restore, corrupt database rejection, stale sidecars, and symlink rejection.
`node deploy/smoke-test.mjs` builds the pinned image and runs Compose with an
isolated, network-restricted synthetic fixture. It checks authentication,
disconnect/reconnect, graceful interruption, restart persistence, and a
synthetic backup/restore round trip. The smoke run requires Docker Engine,
Docker Compose v2, OpenSSL, and access to pull the pinned base and proxy images;
it removes its temporary containers, network, image, credentials, certificates,
and synthetic workspace when it finishes.

When registry access is unavailable, the smoke runner also accepts explicit
local image references paired with their full config digests. It checks each
reference's Docker image ID before using it, passes a local Node base only to
that test build, and does not use `--pull` for that build. For example, replace
the placeholders with locally imported images whose content you have verified:

```sh
node deploy/smoke-test.mjs \
  --local-base-image 'LOCAL_NODE_IMAGE=sha256:VERIFIED_NODE_CONFIG_DIGEST' \
  --local-proxy-image 'LOCAL_NGINX_IMAGE=sha256:VERIFIED_NGINX_CONFIG_DIGEST'
```

This local-image mode is explicit and does not change the pinned defaults in
the Dockerfile or Compose file.
