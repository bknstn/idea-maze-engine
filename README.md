# Idea Maze Engine

Turn a product or workflow idea into explicit hypotheses, bounded research
plans, and source-grounded evidence that helps you decide what to test next.

The primary workflow is user-led hypothesis research. Save a case and its
hypotheses, plan supporting and challenging queries, inspect verified excerpts,
and read coverage gaps through the shared CLI or MCP service. The application
does not calculate a probability of success or an aggregate market score.

The repository also retains a separate Reddit opportunity-discovery pipeline.
It collects posts, extracts signals, groups insights, and ranks candidates
before its evidence checks and human review gate. See
[the legacy pipeline quick start](#legacy-reddit-opportunity-quick-start).

This repository contains the TypeScript application, SQLite schema, CLI and MCP
adapters, and tests. Your collected content, database, credentials, and
generated research should stay outside version control.

## Start with hypothesis research

Follow the [hypothesis research quickstart](docs/guides/hypothesis-research-quickstart.md)
to install dependencies, choose a private workspace, inspect provider
capabilities, and create a synthetic case. Case creation and supplied-plan
validation work without model credentials. A run without usable search or model
providers reports **`insufficient_evidence`** and coverage gaps; it does not treat
missing collection as evidence against an idea.

## What the hypothesis workflow does

1. **Capture:** save an explicit case and user-supplied testable hypotheses.
2. **Plan:** balance supporting and challenging research queries within hard
   query, page, time, and token ceilings.
3. **Collect:** search and attempt to retrieve original public sources.
4. **Assess:** verify excerpts against fetched originals and report support,
   contradiction, context, and coverage limitations.
5. **Decide:** inspect the result and choose a next experiment; the tool does
   not decide whether an idea should be built.

The [CLI](docs/cli.md#case-first-hypothesis-research-cli) and
[MCP service](docs/guides/hypothesis-research-mcp.md) call the same application.
One MCP service instance owns active research runs in a workspace; CLI reads may
use the same database. The service is not multi-tenant or designed for
replicated instances.

## Legacy Reddit opportunity pipeline

Reddit is the active ingestion source for this separate workflow. Gmail and
Telegram commands currently print a skip message; they do not connect to
accounts. Optional web search adds market context. A high score alone does not
establish buyer demand or guarantee that an opportunity reaches review.

## Legacy Reddit opportunity quick start

Use Node.js 22.x, npm, and Git. The clean install was verified on Node.js
22.22.2 and npm 10.9.7; `package.json` currently declares Node.js 20 or newer,
but this release check did not run on Node 20. `better-sqlite3` uses a
native module; platforms without a prebuilt binary also need native build
tools.

```bash
git clone https://github.com/bknstn/idea-maze-engine.git
cd idea-maze-engine
npm ci
npm run idea:status -- --json
```

The status command initializes an empty local database at `data/lab.db`. No API
key is needed to inspect status, run tests, or use heuristic extraction.

Choose which communities to read. Runtime settings live in SQLite; this example
sets two public subreddits and can be rerun to replace that list:

```bash
node --import tsx --input-type=module <<'JS'
import { getDb, closeDb } from './src/idea-maze/scripts/lib/db.ts';
import { initSchema } from './src/idea-maze/scripts/lib/schema.ts';
import { setAppState } from './src/idea-maze/scripts/lib/queries.ts';

initSchema(getDb());
setAppState('reddit_subreddits', ['productivity', 'selfhosted']);
closeDb();
JS
```

Collect and rank your first batch:

```bash
npm run idea:ingest:reddit
npm run idea:extract
npm run idea:refresh
npm run idea:latest -- --json
```

Ingestion requires network access. With no LLM credential set, extraction uses
keyword heuristics. Empty results are possible: feed availability, source
quality, and evidence requirements all affect what is surfaced.

## Enable model-assisted research

Copy the configuration template and fill in credentials locally:

```bash
cp .env.example .env
# Edit .env, then export its values in this shell:
set -a
. ./.env
set +a
```

The CLI reads exported environment variables; it does **not** automatically load
`.env`. The shipped model names are listed in the template. Override them with
models available to your API account before running model-assisted stages.

```bash
npm run idea:run -- --json
```

This runs Reddit ingestion, extraction, opportunity refresh, automatic research,
and a retention inspection. Configured model and search providers can incur API
costs. The research stage considers candidates with scores of at least 9/10,
applies evidence and duplicate checks, and starts at most three new research
runs by default. It leaves qualifying drafts for human review.

See [configuration](docs/configuration.md) for provider settings, workspace
resolution, data flow, and optional integrations.

## Work with opportunities

Use a slug from `idea:latest` and a research run ID from the opportunity details:

| Task | Command |
| --- | --- |
| Pipeline status | `npm run idea:status -- --json` |
| Ranked opportunities | `npm run idea:latest -- --limit 10 --json` |
| Evidence and run details | `npm run idea:explain -- --id <slug> --json` |
| Request a research draft | `npm run idea:research -- <slug> --json` |
| Approve a research run | `npm run idea:review -- --run-id <run-id> --approve --json` |
| Reject with feedback | `npm run idea:review -- --run-id <run-id> --reject --reason weak_wtp --json` |
| Explore an approved opportunity | `npm run idea:explore -- --id <slug> --json` |
| List published local artifacts | `npm run idea:artifacts -- --json` |
| List exploration briefs | `npm run idea:explorations -- --json` |

For case-first hypothesis research, run `npm run idea:research:cli -- --help`;
see the [hypothesis research CLI guide](docs/cli.md#case-first-hypothesis-research-cli).
Agent clients can use the [HTTP or stdio MCP service](docs/guides/hypothesis-research-mcp.md)
through `npm run --silent idea:mcp` with the documented environment configuration.

The angle-bracket values are placeholders. Research drafts are stored in SQLite
run metadata and can be inspected with `idea:explain`. CLI approval records the
decision; it does not export a Markdown artifact. Exploration normally requires
an approved, active opportunity and writes a local Markdown brief. The library
also has a separate local research-artifact publication function; the current
CLI does not invoke it. The engine does not publish output to GitHub.

See the [CLI guide](docs/cli.md) for diagnostics, review reasons, external
exploration handoff, and maintenance.

## Data and privacy

```text
data/
  lab.db          # Sources, insights, opportunities, feedback, and run history
  raw/            # Collected posts and search responses
  artifacts/      # Published research Markdown
  explorations/   # Local exploration Markdown
```

The legacy pipeline defaults `IDEA_MAZE_HOME` to the repository root. The
case-first research runtime defaults it to the current working directory; both
use `data/lab.db` beneath the selected workspace. Legacy collection and
publication paths include `data/raw/`, `data/artifacts/`, and
`data/explorations/`.
The research runtime resolves a workspace-level `artifacts/` path, while its
current CLI/MCP result operation returns paginated JSON or Markdown in the
response and does not publish a Markdown file. Set one explicit existing
`IDEA_MAZE_HOME` for CLI and MCP processes that should share a workspace. See
[workspace configuration](docs/configuration.md#workspace-and-storage).

Runtime data can contain post authors, source text, research notes, and model
output. When configured, external providers can receive selected case context,
queries, retrieved source text, and excerpts. Review generated material before
sharing it. Runtime-data ignore rules are described in the
[self-hosting guide](docs/guides/self-hosting.md).
See [security guidance](SECURITY.md) and the
[publication audit](docs/security-audit.md) for data-handling guidance and the
scope of the repository audit.

## Development

```bash
npm ci
npm run verify                    # TypeScript, application and deployment tests
npm run idea:eval:evidence-quotes  # Deterministic synthetic quote evaluation
```

The case-first application is under [`src/idea-maze/research/`](src/idea-maze/research/),
its MCP adapter under [`src/idea-maze/mcp/`](src/idea-maze/mcp/), and the legacy
CLI scripts under [`src/idea-maze/scripts/`](src/idea-maze/scripts/). Tests use
isolated SQLite databases and mocked provider calls.

The deterministic quote evaluation measures quote validation behavior, not
real-world discovery success; see the
[quote evaluation report](docs/evidence-quote-evaluation-2026-09-24.md). The
hypothesis-research evaluation is also an offline synthetic regression, not a
model-accuracy, usefulness, or release-quality result; see its
[limitations and results](docs/evaluations/hypothesis-research-v1.md) and the
[release verification record](docs/guides/release-verification.md).

Pull requests should describe the problem, resulting behavior, and validation.
Use synthetic examples and keep collected content and credentials out of diffs.
CI runs the verification suite and scans Git history for secrets.

## Documentation

- [Configuration and integrations](docs/configuration.md)
- [CLI reference](docs/cli.md)
- [Hypothesis research quickstart](docs/guides/hypothesis-research-quickstart.md)
- [Self-hosted MCP service](docs/guides/self-hosting.md)
- [Release verification and limitations](docs/guides/release-verification.md)
- [Architecture decision records, in chronological order](docs/adr/README.md)
- [Documentation index and unimplemented proposals](docs/README.md)
- [Agent development guide](AGENTS.md)

## License

[MIT License](LICENSE).
