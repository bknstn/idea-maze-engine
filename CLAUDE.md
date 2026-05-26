# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck          # TypeScript type checking (tsc --noEmit)
npm test                   # Run tests once (Vitest)
npm run test:watch         # Vitest watch mode
npm run verify             # typecheck + tests

# Pipeline stages (run individually)
npm run idea:ingest:reddit
npm run idea:ingest:gmail
npm run idea:ingest:telegram
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
```

## Architecture

All source lives under `src/idea-maze/scripts/`. It's a 4-stage ETL pipeline backed by a single SQLite database (`data/lab.db`).

### Pipeline stages

1. **Ingest** (`ingest-*.ts`) — Fetches raw content from Reddit, Gmail, and Telegram. Deduplicates on `(source, external_id)` with SHA256 hash change detection. Stores into `source_items`.

2. **Extract** (`extract-insights.ts`) — Runs Claude Haiku (with OpenAI fallback) in batches of 8 to classify each source item into typed insights: `pain_point`, `demand_signal`, `workflow_gap`, `distribution_clue`, `willingness_to_pay`, `competitor_move`, `implementation_constraint`. Falls back to keyword heuristics when no API key is present.

3. **Refresh** (`refresh-opportunities.ts`) — Groups insights by `cluster_key` (derived from top keywords), computes a weighted `market_score`, applies a learned `taste_adjustment`, and upserts into `opportunities`. Links opportunities to source items via `opportunity_sources`.

4. **Process** (`process-opportunities.ts`) — Auto-researches opportunities with `final_score ≥ 9.0`. Calls `research-opportunity.ts` which pulls cross-source evidence (inbox signals, Telegram, Reddit, Tavily web search) and drafts a markdown artifact via Claude Sonnet.

### Key library modules (`src/idea-maze/scripts/lib/`)

| File | Responsibility |
|------|---------------|
| `db.ts` | SQLite singleton (WAL mode, foreign keys on) — all DB ops are **synchronous** |
| `schema.ts` | Schema init and migrations; FTS5 virtual tables with auto-sync triggers |
| `queries.ts` | All upsert/fetch/aggregate queries |
| `llm.ts` | Anthropic + OpenAI clients; batch extraction; provider selection logic |
| `prompts.ts` | System/user prompt templates for extraction and research drafts |
| `scoring.ts` | Harvest scoring (keyword patterns, weights per signal type) |
| `taste.ts` | Taste profile: learns from approval/rejection, adjusts future scores |
| `opportunity-state.ts` | Lifecycle transitions and state machine logic |
| `opportunity-policy.ts` | Score bucketing (≥9 → publish, <9 → ignore) |
| `research.ts` | Draft generation from clustered evidence; artifact creation |
| `run-events.ts` | Run lifecycle, event recording, structured audit trail |
| `artifact-export.ts` | GitHub repository push logic |
| `paths.ts` | Data directory resolution (`IDEA_MAZE_HOME` override) |

### Data model highlights

- **`source_items`** → **`insights`** → **`opportunities`** is the core chain
- Opportunity lifecycle: `scored → shortlisted → researching → review_gate → artifact → approved/rejected → archived`
- `taste_profile` table stores learned feature weights (updated by `approvals` table entries)
- FTS5 virtual tables (`source_items_fts`, `insights_fts`, `opportunities_fts`) are maintained by triggers — no manual sync needed
- `app_state` table holds runtime config (subreddits, channels, etc.) rather than env vars or config files

### Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Primary LLM (Claude Haiku for extraction, Sonnet for research) |
| `OPENAI_API_KEY` | Fallback LLM if Anthropic unavailable |
| `TAVILY_API_KEY` | Web search enrichment during research (optional) |
| `IDEA_MAZE_HOME` | Override data directory root (default: project root) |
| `IDEA_MAZE_ARTIFACTS_REPO_URL` / `_BRANCH` | GitHub export target |

### Testing

Tests use real SQLite (temp files or in-memory), no mocking. Each test sets its own `IDEA_MAZE_HOME` to an isolated temp directory and cleans up after. There are no integration or e2e tests — Vitest unit tests only.
