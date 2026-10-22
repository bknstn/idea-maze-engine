# CLI guide

Run commands from the repository root after `npm ci`. npm passes arguments after
`--` to the CLI. `<slug>`, `<run-id>`, and `<timestamp>` below denote values you
replace with your own. JSON mode is supported by the commands that show it;
individual ingestion/extraction/refresh/process stages print progress text.

## Pipeline and inspection

| Command | Behavior |
| --- | --- |
| `npm run idea:status -- --json` | Initialize schema if necessary and report pipeline state |
| `npm run idea:run -- --json` | Run Reddit → extract → refresh → process → retention inspection, with overlap protection |
| `npm run idea:latest -- --limit 10 --json` | List ranked opportunities |
| `npm run idea:explain -- --id <slug> --json` | Show an opportunity, linked evidence, and research runs |
| `npm run idea:ingest:reddit` | Fetch a rotating batch of configured Reddit feeds |
| `npm run idea:extract` | Extract typed insights with the configured model or heuristics |
| `npm run idea:refresh` | Cluster insights and refresh opportunity scores |
| `npm run idea:process -- --limit 3` | Evaluate candidates and limit new automated research runs |
| `npm run idea:inspect:reddit -- --since <timestamp> --json` | Inspect harvest scores and coverage since an ISO timestamp |
| `npm run idea:inspect:review-gate -- --json` | Summarize evidence-quality and review-gate diagnostics |

The pipeline records stage failures and continues to later stages. Inspect its
JSON `ok`, `failedStages`, and stage results when integrating with a scheduler;
process exit status alone does not describe stage success.

## Research and human review

```text
npm run idea:research -- <slug> --json
npm run idea:explain -- --id <slug> --json
npm run idea:review -- --run-id <run-id> --approve --json
npm run idea:review -- --run-id <run-id> --reject --reason weak_wtp --json
```

The manual research command requests a draft; it does not approve the idea.
Review a research run using its ID. Rejections accept repeated `--reason`
arguments or a comma-separated `--reasons` value, plus optional `--notes`.
Run `npm run idea:review` without arguments to print accepted reason labels and
usage (it exits with an error because required arguments are missing).

Review metadata uses the neutral actor `user` unless a caller of the library
supplies `decidedBy`. Rejection reasons and prior publication feedback are
recorded for scoring and duplicate checks. Approval keeps an opportunity active
and makes it eligible for exploration. Generated artifact files remain local.

## Exploration

```text
npm run idea:explore -- --id <slug> --json
npm run idea:explorations -- --limit 20 --json
```

Exploration normally requires an active, approved opportunity. A brief contains
customer hypotheses, evidence gaps, competitors, interviews, smoke tests, kill
criteria, and a recommended next action. It does not overwrite human approval
or rejection. `--force` explicitly bypasses the eligibility guard.

To use an external model or a manual workflow:

```text
npm run idea:explore -- --id <slug> --prepare-only --json
npm run idea:explore -- --run-id <run-id> --brief-file /path/to/brief.json --json
```

The first command creates a run and returns context, prompts, and the expected
schema. The second validates and finalizes the supplied JSON for that run.
Optional `--provider-metadata` takes a JSON object describing its provenance.
If generation or validation fails, inspect `needs_manual_exploration` and the
reported errors before retrying.

## Local artifacts and maintenance

| Command | Behavior |
| --- | --- |
| `npm run idea:artifacts -- --limit 20 --json` | List research artifact records and paths |
| `npm run idea:retention -- --days 30 --json` | Inspect old artifacts/explorations for archived opportunities; does not delete them |
| `npm run idea:backfill-evidence-excerpts -- --limit 100` | Dry-run exact excerpt recovery from legacy metadata; no model calls |
| `npm run idea:backfill-evidence-excerpts -- --apply --limit 100` | Save recovered excerpts for the selected batch |
| `npm run idea:eval:evidence-quotes` | Emit deterministic metrics for the synthetic quote fixtures |

Backfill defaults to a 100-row dry run. It searches only the first 1,500 UTF-16
code units visible to the legacy batch extractor and skips already backfilled
rows. Read the dry-run counts before applying it.

`idea:revalidate:review-gate` supports reassessing existing drafts, including an
`--apply` mode that changes state. Inspect the script's argument handling and
use a database backup before applying maintenance to a valuable dataset.

See [configuration](configuration.md) for storage and provider setup, and
[security guidance](../SECURITY.md) before sharing generated reports.
