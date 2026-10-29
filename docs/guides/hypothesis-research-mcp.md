# Hypothesis research MCP service

Run the service from the repository root with `npm run idea:mcp`. The package
command invokes `node --import tsx src/idea-maze/scripts/research-mcp.ts`. HTTP
is the default transport and listens at `/mcp` on `127.0.0.1:8787`. The bind
host can be set to `::1`; other bind addresses are rejected. Port `0` asks the
operating system for an available port.

Both transports use the same version 1.0.0 research application as the
case-first CLI. The supported tools are:

| Tool | Purpose |
| --- | --- |
| `research_capabilities` | Read configured providers, hard limits, and workspace mode |
| `research_case_create` | Save an intake and caller-supplied hypotheses |
| `research_case_get` | Read the latest or a historical case revision |
| `research_case_update` | Append a case or hypothesis revision |
| `research_plan` | Validate a supplied plan or create a bounded local plan; model suggestions are opt-in |
| `research_start` | Start service-owned provider work |
| `research_status` | Read run state, step status, gaps, and available usage |
| `research_result` | Read a bounded JSON or Markdown result page |
| `research_cancel` | Request cancellation of an active run |

Requests cannot choose a database path, provider, credential, shell command, or
arbitrary filesystem path. Case writes and run-changing requests use
idempotency keys; stale case or hypothesis revisions return conflicts.
Suggestions returned by a model are not active hypotheses until the caller
explicitly accepts one in a later case update.

HTTP startup requires `IDEA_MAZE_MCP_BEARER_TOKEN` and
`IDEA_MAZE_MCP_BEARER_TOKEN_EXPIRES_AT`. Store the token in an environment
secret or secret manager, and set its expiry to a future ISO-8601 timestamp
with an explicit timezone. Generate a fresh token locally if needed, for
example with `openssl rand -hex 32`; do not put it in command-line arguments,
tool inputs, or URLs. Missing, malformed, or expired credentials stop startup.
`IDEA_MAZE_MCP_HTTP_HOST` accepts only `127.0.0.1` or `::1` and defaults to
`127.0.0.1`; `IDEA_MAZE_MCP_HTTP_PORT` defaults to `8787`.

## SDK client setup

These examples use the official MCP SDK v2 client package included as a
development dependency after `npm ci`. They show transport and authentication
settings without assuming a particular agent host's JSON configuration format.
Both call only `research_capabilities`, so they do not start provider work.

For authenticated loopback HTTP, start the MCP service separately with the
required bearer-token environment variables, then run this client from the
repository root. Put the token in the process environment; the example never
puts it in a URL or command argument:

```bash
node --import tsx --input-type=module <<'JS'
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const token = process.env.IDEA_MAZE_MCP_BEARER_TOKEN;
if (!token) throw new Error("Set IDEA_MAZE_MCP_BEARER_TOKEN in this client process.");

const client = new Client({ name: "idea-maze-example", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(
  new URL(process.env.IDEA_MAZE_MCP_URL ?? "http://127.0.0.1:8787/mcp"),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
);
try {
  await client.connect(transport);
  const result = await client.callTool({ name: "research_capabilities", arguments: {} });
  console.log(JSON.stringify(result.structuredContent));
} finally {
  await client.close();
}
JS
```

For a local subprocess, use stdio and pass an explicit workspace to the
service. The example's child environment includes only `PATH`, the workspace,
and the stdio transport setting, so provider credentials are intentionally not
passed through. It reads capabilities only and does not start provider work.
For actual research, add the required provider variables to the child
environment from your private configuration. Starting a stdio server does not
require the HTTP bearer settings:

```bash
node --import tsx --input-type=module <<'JS'
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const client = new Client({ name: "idea-maze-example", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/idea-maze/scripts/research-mcp.ts"],
  cwd: process.cwd(),
  env: {
    PATH: process.env.PATH ?? "",
    IDEA_MAZE_HOME: process.env.IDEA_MAZE_HOME ?? process.cwd(),
    IDEA_MAZE_MCP_TRANSPORT: "stdio",
  },
  stderr: "inherit",
});
try {
  await client.connect(transport);
  const result = await client.callTool({ name: "research_capabilities", arguments: {} });
  console.log(JSON.stringify(result.structuredContent));
} finally {
  await client.close();
}
JS
```

The HTTP and stdio client wiring is exercised with the official SDK in
[`runtime.test.ts`](../../src/idea-maze/mcp/runtime.test.ts) and the
cross-interface fixture in
[`workflow-integration.test.ts`](../../src/idea-maze/research/workflow-integration.test.ts).
An MCP client application may expose equivalent transport settings in its own
configuration format; follow that application's documentation for its schema.

`IDEA_MAZE_HOME` selects an existing workspace directory for the research
database and related data. If it is unset, the current working directory is
used. The database is `data/lab.db` under the research workspace. The research
context resolves a separate workspace-level `artifacts/` path; current result
pages are returned to the client and are not automatically published as files.
The legacy opportunity pipeline instead defaults its workspace to the
repository root and publishes legacy artifacts under `data/artifacts/`. See
[workspace configuration](../configuration.md#workspace-and-storage).
Use one MCP service instance per workspace; CLI reads may use the same
database. Do not run independent replicated service instances against a shared
workspace.

The host and trust settings accept JSON arrays rather than comma-separated
lists:

- `IDEA_MAZE_MCP_ALLOWED_HOSTS` defaults to `["127.0.0.1", "localhost", "::1"]` and is capped at 64 entries.
- `IDEA_MAZE_MCP_ALLOWED_ORIGINS` defaults to `[]`; add explicit HTTP(S) origins only for browser clients.
- `IDEA_MAZE_MCP_TRUSTED_PROXY_PEERS` defaults to `[]` and accepts at most 32 IP literals.

JSON list values are limited to 16 KiB. Trusted proxy peers must be configured
explicitly. Remote clients require TLS through an explicitly configured reverse
proxy. The [self-hosting guide](self-hosting.md) documents the packaged Compose
deployment and its trust boundary. For trusted proxy peers, the HTTP policy
accepts exactly `X-Forwarded-Proto: https` and rejects other forwarded headers. Optional
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

The application caps plans at 40 queries, 100 fetched pages, 3 follow-up
rounds, 900 seconds, and 20,000 input and output model tokens. Plans may use
lower limits but cannot raise them. Provider-reported token or cost usage is
recorded when available; an unknown value remains null and is not a zero-cost
claim. These limits are not a guaranteed monetary ceiling. Set spending limits
at the provider account if required. See the
[CLI guide](../cli.md#case-first-hypothesis-research-cli) for request envelopes,
pagination, cancellation, and exit behavior.
