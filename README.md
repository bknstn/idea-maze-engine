# Idea Maze Engine

CLI-first product discovery pipeline.

Source code lives under `src/idea-maze/scripts`.

## CLI Contract

Use these stable commands:

```bash
npm run idea:status -- --json
npm run idea:run -- --json
npm run idea:latest -- --json
npm run idea:explain -- --id <slug> --json
npm run idea:research -- <slug>
npm run idea:explore -- --id <slug> --json
npm run idea:artifacts -- --json
npm run idea:explorations -- --json
```

Additional stage commands:

```bash
npm run idea:ingest:reddit
npm run idea:ingest:gmail
npm run idea:ingest:telegram
npm run idea:extract
npm run idea:refresh
npm run idea:process
npm run idea:backfill-evidence-excerpts -- --help
```

The evidence-excerpt backfill is opt-in and makes no LLM calls. It runs a
100-row dry run by default; review the counts, then pass `--apply` to save exact
matches found in legacy insight metadata. It only searches the first 1,500
UTF-16 code units that the legacy batch extractor could see. Re-running skips
rows already backfilled; use `--limit N` to process a bounded batch at a time.

## Data

Runtime state lives in:

```text
data/lab.db
data/raw/
data/artifacts/
```

These files are intentionally ignored by git. Set `IDEA_MAZE_HOME` to store
runtime state somewhere else.

## LLM configuration

Idea Maze routes LLM work by task rather than by vendor. OpenAI is the active
adapter; the provider boundary can support other request/response formats
without changing pipeline stages.

```bash
OPENAI_API_KEY=...
IDEA_MAZE_LLM_PROVIDER=openai
IDEA_MAZE_EXTRACTION_MODEL=gpt-5.6-luna
IDEA_MAZE_RESEARCH_MODEL=gpt-5.6-terra
IDEA_MAZE_EXPLORATION_MODEL=gpt-5.6-sol
```

The provider defaults to `openai`, and each model has the value shown above by
default. New vendors implement `LlmProviderAdapter` and register through
`registerLlmProvider`; the pipeline does not perform implicit vendor fallback.

## Development

```bash
npm install
npm run idea:status -- --json
npm run idea:eval:evidence-quotes
npm test
npm run typecheck
```
