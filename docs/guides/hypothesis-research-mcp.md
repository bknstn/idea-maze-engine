# Hypothesis research MCP service

Run the service from the repository root with `npm run idea:mcp`. The package
command invokes `node --import tsx src/idea-maze/scripts/research-mcp.ts`. HTTP
is the default transport and listens at `/mcp` on `127.0.0.1:8787`. The bind
host can be set to `::1`; other bind addresses are rejected. Port `0` asks the
operating system for an available port.

HTTP startup requires `IDEA_MAZE_MCP_BEARER_TOKEN` and
`IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT`. Store the token in an environment
secret or secret manager, and set its expiry to a future ISO-8601 timestamp
with an explicit timezone. Generate a fresh token locally if needed, for
example with `openssl rand -hex 32`; do not put it in command-line arguments,
tool inputs, or URLs. Missing, malformed, or expired credentials stop startup.
`IDEA_MAZE_MCP_HTTP_HOST` accepts only `127.0.0.1` or `::1` and defaults to
`127.0.0.1`; `IDEA_MAZE_MCP_HTTP_PORT` defaults to `8787`.

`IDEA_MAZE_HOME` selects an existing workspace directory for the research
database and related data. If it is unset, the current working directory is
used. The host and trust settings accept JSON arrays rather than comma-separated
lists:

- `IDEA_MAZE_MCP_ALLOWED_HOSTS` defaults to `["127.0.0.1", "localhost", "::1"]` and is capped at 64 entries.
- `IDEA_MAZE_MCP_ALLOWED_ORIGINS` defaults to `[]`; add explicit HTTP(S) origins only for browser clients.
- `IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS` defaults to `[]` and accepts at most 32 IP literals.

JSON list values are limited to 16 KiB. Trusted proxy peers must be configured
explicitly. Remote clients require TLS through an explicitly configured reverse
proxy; deployment packaging remains separate work. For those peers, the HTTP policy accepts exactly
`X-Forwarded-Proto: https` and rejects other forwarded headers. Optional
`IDEA_MAZE_MCP_HTTP_MAX_BODY_BYTES` is bounded from 1 KiB to 1 MiB. The rate
settings `IDEA_MAZE_MCP_HTTP_RATE_LIMIT_REQUESTS`,
`IDEA_MAZE_MCP_HTTP_RATE_LIMIT_WINDOW_MS`, and
`IDEA_MAZE_MCP_HTTP_RATE_LIMIT_MAX_TRACKED_PEERS` are also bounded by the
security policy.

For a local MCP client that launches a subprocess, set
`IDEA_MAZE_MCP_TRANSPORT=stdio` in the process environment and run
`npm run --silent idea:mcp` (or invoke the direct Node command above). Use the
silent npm form because npm's launcher banners would otherwise appear on
stdout and break MCP framing. Stdio mode uses the invoking process's
permissions and does not require HTTP bearer configuration. The server writes
protocol messages only to stdout; diagnostics go to stderr. Importing runtime
modules alone does not open a database or contact a provider; the executable
composes the runtime when it starts.

Research runs belong to the service process. Closing an HTTP client does not
cancel a run; use `research_cancel` to request cancellation. Stdio EOF,
`SIGINT`, or `SIGTERM` shuts down the service, aborts active work, waits for run
cleanup, and then closes the database. Status and result reads do not start
provider work. When enabled, model and search providers can receive selected
case details, planned search queries, retrieved source text, and excerpts as
needed for the requested workflow. Keeping the database in a local workspace
does not guarantee that this selected research context stays local.
