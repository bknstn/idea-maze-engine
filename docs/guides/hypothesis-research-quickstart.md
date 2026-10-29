# Hypothesis research quickstart

This guide starts with a user-supplied idea and hypothesis. It uses the
case-first research CLI; the Reddit opportunity pipeline is a separate legacy
workflow documented in the [CLI guide](../cli.md).

## Install

Use Node.js 22.x, npm, and Git. The clean-install check used Node.js 22.22.2
with npm 10.9.7. The package declares Node.js 20 or newer, but Node 20 was not
verified in that check; see the [release verification record](release-verification.md).

```bash
git clone https://github.com/bknstn/idea-maze-engine.git
cd idea-maze-engine
npm ci
```

`better-sqlite3` includes a native module. If npm cannot use a prebuilt binary
for your platform, install the platform's native build tools.

## Choose a workspace

The research runtime uses `IDEA_MAZE_HOME` when set and otherwise uses the
process working directory. The directory must already exist. Select a durable
private directory outside the repository and use the same path for later CLI
and MCP sessions:

```bash
mkdir -p /absolute/path/to/idea-maze-workspace
export IDEA_MAZE_HOME=/absolute/path/to/idea-maze-workspace
```

The case-first research runtime and the legacy pipeline resolve their default
workspace differently; see [configuration](../configuration.md#workspace-and-storage)
before mixing the two workflows.

## Check capabilities and create a case

Capabilities are read-only and work without provider credentials:

```bash
npm run --silent idea:research:cli -- capabilities
```

The result reports configured provider availability and hard resource ceilings.
Create a synthetic case by sending one JSON object on stdin:

```bash
cat <<'JSON' | npm run --silent idea:research:cli -- case-create
{"idempotencyKey":"sample-case-create-001","intake":{"ideaSummary":"A sample workflow helper","targetUser":"Independent tutors","problem":"Session notes take time","proposedSolution":"A structured note template"},"hypotheses":[{"claim":"Tutors spend time rewriting session notes"}]}
JSON
```

The case and user-supplied hypothesis are stored in the selected workspace. The
response includes the case ID, revision, and hypothesis ID. Use those returned
values for later requests; every write operation needs an idempotency key.
Keep idea text on stdin rather than in shell arguments or URLs.

See the [CLI guide](../cli.md#case-first-hypothesis-research-cli) for the
supplied-plan format, support and challenge query requirements, run controls,
status/result pagination, cancellation, and exit codes. The plan command can
validate a supplied plan or make a bounded local plan from the active
hypotheses without a model. Model-generated suggestions are an explicit
opt-in. A completed run without usable search/model providers correctly reports
`insufficient_evidence` and coverage gaps; it does not mean the hypothesis is
false.

## Configure research providers

The built-in model adapter uses `OPENAI_API_KEY` and the research model setting.
Search enrichment uses `TAVILY_API_KEY`. The CLI reads exported environment
variables and does not load `.env` automatically. See
[configuration](../configuration.md) for the provider and data-flow details.
Provider calls can send selected case context, search queries, retrieved source
text, and excerpts outside the workspace. Use synthetic or non-confidential
ideas until you have reviewed the privacy boundaries and provider terms.

The [MCP service](hypothesis-research-mcp.md) exposes the same
case-first application over authenticated loopback HTTP or local stdio.
See the [synthetic end-to-end workflow example](../examples/hypothesis-research-workflow.md)
for equivalent CLI and MCP requests.
