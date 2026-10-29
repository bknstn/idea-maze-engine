# Idea Maze Engine

Turn recurring problems in Reddit discussions into evidence-backed product
opportunities, research drafts, and plans for testing an idea.

Idea Maze is a local, CLI-first product discovery pipeline for founders and
researchers who want to keep the connection between an idea and the sources
that support it. It collects posts, extracts signals such as pain points and
workarounds, groups related insights, and ranks opportunities. Evidence checks
filter candidates before automated research; human review records approvals
and rejection reasons to inform future scoring.

This repository contains the TypeScript engine, SQLite schema, CLI commands,
and tests. Your collected content, database, credentials, and generated research
stay outside version control.

## What it does

1. **Collect:** fetch Reddit RSS feeds, deduplicate posts, and track coverage gaps.
2. **Extract:** identify pain points, demand, workflow gaps, willingness to pay,
   distribution clues, competitor activity, and implementation constraints.
3. **Rank:** cluster insights and combine market scores with learned preferences.
4. **Research:** check independent, relevant source evidence and draft promising
   opportunities for review.
5. **Explore:** turn an approved opportunity into a brief with a target customer,
   competitors, interview questions, experiments, and kill criteria.

Reddit is the active ingestion source. Gmail and Telegram commands currently
print a skip message; they do not connect to accounts. Optional web search adds
market context. A high score alone does not establish buyer demand or guarantee
that an opportunity reaches review.

## Quick start

Use **Node.js 22.12 or newer on the 22.x line**, npm, and Git. `better-sqlite3`
uses a native module; platforms without a prebuilt binary also need native
build tools.

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

See [configuration](docs/configuration.md) for provider settings, data flow,
and optional integrations.

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

Set `IDEA_MAZE_HOME` to another directory to place `data/` there. Use the same
value for every command that should share a database.

Runtime data can contain post authors, source text, research notes, and model
output. When configured, external providers receive selected source context or
search queries. Review generated material before sharing it. `.gitignore`
excludes runtime data, local environment files, and common credential formats.
See [security guidance](SECURITY.md) and the [publication audit](docs/security-audit.md)
for data-handling guidance and the scope of the repository audit.

## Development

```bash
npm ci
npm run verify                    # TypeScript checking and Vitest tests
npm run idea:eval:evidence-quotes  # Deterministic synthetic quote evaluation
```

Source code is in [`src/idea-maze/scripts/`](src/idea-maze/scripts/). Tests use
isolated SQLite databases and mocked provider calls. The synthetic quote
evaluation measures quote validation behavior; it does not measure real-world
product discovery success. See its [evaluation report](docs/evidence-quote-evaluation-2026-09-24.md).

Pull requests should describe the problem, resulting behavior, and validation.
Use synthetic examples and keep collected content and credentials out of diffs.
CI runs the verification suite and scans Git history for secrets.

## Documentation

- [Configuration and integrations](docs/configuration.md)
- [CLI reference](docs/cli.md)
- [Architecture decision records, in chronological order](docs/adr/README.md)
- [Documentation index and unimplemented proposals](docs/README.md)
- [Agent development guide](AGENTS.md)

## License

[MIT License](LICENSE).
