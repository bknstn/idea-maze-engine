# Idea Maze Agent Guide

This file provides vendor-neutral guidance for coding agents working in this repository.

## Commands

```bash
npm run typecheck          # TypeScript type checking (tsc --noEmit)
npm test                   # Run tests once (Vitest)
npm run test:watch         # Vitest watch mode
npm run verify             # typecheck + tests

# Pipeline stages (run individually)
npm run idea:ingest:reddit
npm run idea:ingest:gmail   # Disabled stub
npm run idea:ingest:telegram # Disabled stub
npm run idea:extract       # LLM insight extraction
npm run idea:refresh       # Opportunity clustering + scoring
npm run idea:process       # Auto-research high-scoring opportunities

# CLI commands
npm run idea:run           # Full pipeline (all stages in sequence)
npm run idea:status        # Summary report (supports --json)
npm run idea:latest        # Top opportunities
npm run idea:explain       # Details for a specific opportunity by slug
npm run idea:research      # Manual research trigger
npm run idea:artifacts     # List generated artifacts
npm run idea:review        # Apply approval/rejection to a research run ID
npm run idea:explore       # Explore an approved, active opportunity
npm run idea:explorations  # List exploration briefs
npm run idea:retention     # Inspect retention candidates without deleting files
```

## Architecture

All source lives under `src/idea-maze/scripts/`. The four core ETL stages share one SQLite database (`data/lab.db`). The full runner also performs a read-only retention inspection. Human review and exploration have separate CLI commands.

### Pipeline stages

1. **Ingest** (`ingest-reddit.ts`) — Fetches public Reddit RSS feeds from the `reddit_subreddits` app-state setting, rotates batches, and records coverage gaps. Deduplicates on `(source, external_id)` with SHA256 hash change detection. Stores into `source_items`. Gmail and Telegram ingestion/authentication are disabled stubs.

2. **Extract** (`extract-insights.ts`) — Uses the configured extraction model in batches of eight to classify each source item into typed insights: `pain_point`, `demand_signal`, `workflow_gap`, `distribution_clue`, `willingness_to_pay`, `competitor_move`, `implementation_constraint`. Falls back to keyword heuristics when no LLM provider is configured.

3. **Refresh** (`refresh-opportunities.ts`) — Groups insights by `cluster_key` (derived from top keywords), computes a weighted `market_score`, applies a learned `taste_adjustment`, and upserts into `opportunities`. Links opportunities to source items via `opportunity_sources`.

4. **Process** (`process-opportunities.ts`) — Evaluates opportunities with `final_score >= 9.0` using duplicate, deterministic evidence, and thesis-alignment checks. Calls `lib/research.ts` for eligible candidates, with at most three new research runs by default. Qualifying drafts remain at the review gate; fallback templates are quarantined.

### Key library modules (`src/idea-maze/scripts/lib/`)

| File | Responsibility |
|------|---------------|
| `db.ts` | SQLite singleton (WAL mode, foreign keys on); all DB operations are synchronous |
| `schema.ts` | Schema initialization and migrations; FTS5 virtual tables with auto-sync triggers |
| `queries.ts` | Upsert, fetch, and aggregate queries |
| `llm.ts` | Provider-neutral task routing, model configuration, and provider adapters |
| `prompts.ts` | System and user prompt templates for extraction and research drafts |
| `scoring.ts` | Harvest scoring (keyword patterns and weights per signal type) |
| `taste.ts` | Taste profile learning and future score adjustment |
| `opportunity-state.ts` | Lifecycle transitions and state machine logic |
| `opportunity-policy.ts` | Score bucketing and evidence-adjusted automation eligibility |
| `research.ts` | Draft generation from clustered evidence and artifact creation |
| `run-events.ts` | Run lifecycle, event recording, and structured audit trail |
| `paths.ts` | Data directory resolution (`IDEA_MAZE_HOME` override) |

### LLM provider boundary

Pipeline code selects the `extraction`, `research`, or `exploration` task. It must not branch on vendor names or translate one vendor's model identifiers into another vendor's identifiers.

Provider-specific authentication, request formatting, response parsing, and error handling belong in an `LlmProviderAdapter`. Register adapters through `registerLlmProvider`; select one with `IDEA_MAZE_LLM_PROVIDER`. Do not add implicit cross-provider fallback. Model selection stays vendor-neutral through the three task-specific environment variables below.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Credential used by the active OpenAI adapter |
| `IDEA_MAZE_LLM_PROVIDER` | Registered provider name; defaults to `openai` |
| `IDEA_MAZE_EXTRACTION_MODEL` | Extraction model; defaults to `gpt-5.6-luna` |
| `IDEA_MAZE_RESEARCH_MODEL` | Research model; defaults to `gpt-5.6-terra` |
| `IDEA_MAZE_EXPLORATION_MODEL` | Exploration model; defaults to `gpt-5.6-sol` |
| `TAVILY_API_KEY` | Optional web-search enrichment during research |
| `IDEA_MAZE_HOME` | Data-directory root override; defaults to the project root |

### Data model highlights

- **`source_items`** -> **`insights`** -> **`opportunities`** is the core chain.
- Opportunity lifecycle: `scored -> shortlisted -> researching -> review_gate -> artifact -> approved/rejected -> archived`.
- `taste_profile` stores learned feature weights updated by approval records.
- FTS5 virtual tables are maintained by triggers; no manual sync is needed.
- `app_state` holds runtime configuration rather than environment variables or config files.

### Testing

Tests use real SQLite temporary or in-memory databases. Each test sets `IDEA_MAZE_HOME` to an isolated temporary directory and cleans up afterward. LLM HTTP behavior is unit-tested with mocked `fetch`.

## Public documentation and cleanup

Keep setup and current usage in README and the CLI/configuration guides. Record implemented design changes in `docs/adr/`, using chronological numbers, adoption dates, context, decisions, consequences, and implementation references. Keep unimplemented proposals separate in `docs/proposals/`.

Use synthetic examples. Never add real credentials, reviewer identities, host paths, database exports, or collected source content to documentation or fixtures. Preserve explicit caller-provided identities in runtime data, but use neutral defaults in code.

After every task, remove task-created temporary scripts, probes, scratch files, and validation copies, including after failures. Prefer inline commands or stdin when a saved helper is unnecessary. Verify temporary paths are removed before reporting completion. Preserve deliverables, implementation code, installed integrations, and pre-existing user files.
