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
| `IDEA_MAZE_HOME` | Legacy pipeline defaults to repository root; case-first research defaults to current working directory |
| `OPENAI_API_KEY` | Empty; enables the built-in OpenAI adapter when supplied |
| `IDEA_MAZE_LLM_PROVIDER` | `openai`; must name a registered adapter |
| `IDEA_MAZE_EXTRACTION_MODEL` | `gpt-5.6-luna`; extraction task model |
| `IDEA_MAZE_RESEARCH_MODEL` | `gpt-5.6-terra`; research task model |
| `IDEA_MAZE_EXPLORATION_MODEL` | `gpt-5.6-sol`; exploration task model |
| `TAVILY_API_KEY` | Empty; optional contextual web search |
| `IDEA_MAZE_JEV_ENABLED` | Disabled unless explicitly `true`; optional shadow evidence assessment |
| `TYPESAFE_API_KEY` | Empty; credential for that optional assessment |
| `IDEA_MAZE_JEV_MODEL` | Empty; explicit model required for that optional assessment |

## Workspace and storage

The legacy opportunity pipeline defaults `IDEA_MAZE_HOME` to the repository
root. The case-first research runtime uses `IDEA_MAZE_HOME` when set and
otherwise uses the process working directory; a selected workspace must already
exist. If an MCP client starts the service from a different working directory,
set the same explicit workspace path for the client, CLI, and MCP service that
should share a database.

Both workflows use `data/lab.db` under the selected workspace. Research adds its
own workspace-scoped tables to that database. The legacy publication helper
uses `data/artifacts/`, while the research runtime resolves a separate
workspace-level `artifacts/` path. The current research CLI and MCP result
operation return paginated JSON or Markdown in the response; they do not
publish a Markdown result file. The legacy exploration writer uses
`data/explorations/`.

The case-first runtime can validate a caller-supplied plan or create a bounded
local plan from active hypotheses without model credentials. Model-generated
hypothesis suggestions are opt-in. With no configured search or model provider,
capabilities report that state and a research run records
`provider_unavailable` coverage gaps with an `insufficient_evidence` result.
It does not use the legacy keyword-extraction fallback. The app's hard ceilings
are 40 queries, 100 fetched pages, 3 follow-up rounds, 900 seconds, and 20,000
input and output model tokens; plans can choose lower limits but cannot raise
those ceilings.

Provider usage is retained when the adapter reports it. Unknown token totals
and provider costs stay null rather than being recorded as zero. These
resource ceilings are not an exact monetary spending cap; use provider-side
account limits if a hard cost ceiling is required.

Model defaults describe the checked-in configuration. Select identifiers that
your API account supports; the engine does not translate model names between
providers or fall back to another vendor. A provider adapter implements
`LlmProviderAdapter` and registers through `registerLlmProvider` in
[`llm.ts`](../src/idea-maze/scripts/lib/llm.ts).

In the legacy opportunity pipeline, extraction uses keyword heuristics when no
LLM is configured. Legacy research may produce a fallback template, but that
template is quarantined from normal review and publication. Legacy exploration
cannot make a model-generated brief without a provider; use the external
handoff described in the [CLI guide](cli.md). The case-first research service
records unavailable providers and returns limited evidence results instead of
using these legacy fallbacks.

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

## Legacy storage

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
| Hypothesis-research providers | Configured case-first research | Selected intake/case context, planned queries, retrieved source text, and verified excerpts needed for the run |
| Original-source reader | Case-first retrieval of selected public URLs | Direct requests for the selected public source URLs; fetched text is stored in the workspace |

Web search results are contextual research, not independent primary buyer
evidence. Jev is disabled by default and cannot alter gate decisions or drafts.
It requires all three settings in the environment table; choose a model from
your authenticated TypeSafe model inventory. The implementation has mocked
provider tests, without a claim of live account validation. See
[ADR 0013](adr/0013-shadow-evidence-assessment.md) for diagnostic and cache details.

API calls can incur provider charges. Status, deterministic evaluation, and the
test suite do not require credentials. Run events and provider error messages
may contain source context, so inspect them before sharing diagnostics.
