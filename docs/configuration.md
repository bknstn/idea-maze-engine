# Configuration and integrations

## Environment

The CLI reads `process.env`; it does not load an environment file automatically.
Copy [`.env.example`](../.env.example) to `.env`, edit it locally, then export its
values before starting commands:

```bash
set -a
. ./.env
set +a
```

The template uses shell-compatible assignments. Quote values containing spaces.

| Variable | Default / purpose |
| --- | --- |
| `IDEA_MAZE_HOME` | Repository root; the engine creates `data/` inside it |
| `OPENAI_API_KEY` | Empty; enables the built-in OpenAI adapter when supplied |
| `IDEA_MAZE_LLM_PROVIDER` | `openai`; must name a registered adapter |
| `IDEA_MAZE_EXTRACTION_MODEL` | `gpt-5.6-luna`; extraction task model |
| `IDEA_MAZE_RESEARCH_MODEL` | `gpt-5.6-terra`; research task model |
| `IDEA_MAZE_EXPLORATION_MODEL` | `gpt-5.6-sol`; exploration task model |
| `TAVILY_API_KEY` | Empty; optional contextual web search |
| `IDEA_MAZE_JEV_ENABLED` | Disabled unless explicitly `true`; optional shadow evidence assessment |
| `TYPESAFE_API_KEY` | Empty; credential for that optional assessment |
| `IDEA_MAZE_JEV_MODEL` | Empty; explicit model required for that optional assessment |

Model defaults describe the checked-in configuration. Select identifiers that
your API account supports; the engine does not translate model names between
providers or fall back to another vendor. A provider adapter implements
`LlmProviderAdapter` and registers through `registerLlmProvider` in
[`llm.ts`](../src/idea-maze/scripts/lib/llm.ts).

With no configured LLM, extraction uses keyword heuristics. Research may produce
a fallback template, but that template is quarantined from normal review and
publication. Exploration cannot manufacture a model-generated brief without a
provider; use the external handoff described in the [CLI guide](cli.md).

## Reddit settings

Subreddit selection is a runtime setting in SQLite's `app_state` table, not an
environment variable. Set it from the repository root:

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

An empty database has no subreddit list; ingestion reports an error until one
is configured. Repeating this snippet replaces the list without resetting stored
posts. If you set `IDEA_MAZE_HOME`, export it for this snippet and every CLI run.

Ingestion uses public RSS feeds and needs no Reddit credential. It rotates up
to six communities per run, requests up to 50 entries per community, and tracks
requested time ranges, failures, and coverage gaps. RSS is a bounded feed and
cannot guarantee a complete history of posts. No scheduler is installed by this
repository. Gmail and Telegram ingestion/authentication are disabled stubs.

## Storage

The SQLite database uses WAL mode, foreign keys, and FTS5 indexes. Schema
initialization is automatic in the normal CLI commands. Full-text indexes are
maintained by triggers. Sources, insights, opportunities, review feedback,
provider traces, and run events share the database.

All runtime files normally live beneath `data/`, including `raw/`, `artifacts/`,
and `explorations/`. These paths are ignored by Git. If you store data elsewhere,
keep backups and exports private as well. A consistent SQLite backup must account
for WAL state; do not copy only `lab.db` while a writer is active.

## What leaves the machine

| Integration | When used | Data sent |
| --- | --- | --- |
| Reddit RSS | Ingestion | Subreddit feed requests |
| Selected LLM adapter | Configured extraction, evidence alignment, research, or exploration | Prompts and selected source/opportunity context |
| Tavily | Search enrichment with a configured key | Queries derived from an opportunity and its evidence |
| TypeSafe/Jev | Explicitly enabled shadow diagnostics | Named assessment questions and bounded context from eligible sources with verified excerpts |

Web search results are contextual research, not independent primary buyer
evidence. Jev is disabled by default and cannot alter gate decisions or drafts.
It requires all three settings in the environment table; choose a model from
your authenticated TypeSafe model inventory. The implementation has mocked
provider tests, without a claim of live account validation. See
[ADR 0013](adr/0013-shadow-evidence-assessment.md) for diagnostic and cache details.

API calls can incur provider charges. Status, deterministic evaluation, and the
test suite do not require credentials. Run events and provider error messages
may contain source context, so inspect them before sharing diagnostics.
