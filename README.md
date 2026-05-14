# Idea Maze Engine

CLI-first product discovery pipeline operated by Hermes.

This repo contains the Idea Maze engine that was migrated out of
`idea-maze-claw`. It intentionally keeps the current
`groups/idea-maze/scripts` layout during the cutover so existing Hermes
commands continue to work through the compatibility shim.

## Hermes CLI Contract

Hermes should call these stable commands:

```bash
npm run idea:status -- --json
npm run idea:run -- --json
npm run idea:latest -- --json
npm run idea:explain -- --id <slug> --json
npm run idea:research -- <slug>
npm run idea:artifacts -- --json
```

Additional stage commands:

```bash
npm run idea:ingest:reddit
npm run idea:ingest:gmail
npm run idea:ingest:telegram
npm run idea:extract
npm run idea:refresh
npm run idea:process
```

## Data

Runtime state lives in:

```text
groups/idea-maze/data/lab.db
groups/idea-maze/data/raw/
groups/idea-maze/data/artifacts/
```

These files are intentionally ignored by git. Move them through deployment or
backup tooling, not normal source commits.

## Development

```bash
npm install
npm run idea:status -- --json
npm test
npm run typecheck
```
