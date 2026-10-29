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

## Case-first hypothesis research CLI

The case-first research CLI uses the shared hypothesis-research application and
keeps the legacy opportunity command `idea:research` unchanged. Its npm entry is
`idea:research:cli`, backed by
`node --import tsx src/idea-maze/scripts/research-cli-main.ts`:

```text
npm run idea:research:cli -- --help
npm run --silent idea:research:cli -- <command> [options] < request.json
```

Send one UTF-8 JSON object on stdin (maximum 256 KiB); idea text and other
request values are not command-line arguments. Each operation writes one
schema-versioned JSON envelope to stdout; `--help` prints usage text.
Use `npm run --silent` for machine-readable output to suppress npm launcher
headers. Sanitized diagnostics go to stderr. `capabilities` takes no stdin. The
remaining commands map to the shared application tools:

| Command | Purpose |
| --- | --- |
| `capabilities` | Read provider availability and configured limits |
| `case-create` | Create a case with intake and caller-supplied hypotheses |
| `case-get` | Read the latest case or a selected revision |
| `case-update` | Append an intake or hypothesis revision |
| `plan` | Validate a supplied plan, or create a bounded local plan |
| `start` | Start a run and wait for its terminal result |
| `status` | Read a run's execution status |
| `result` | Read a bounded result page |
| `cancel` | Request cancellation using an idempotency key |

A synthetic case-create request:

```bash
printf '%s' '{"idempotencyKey":"demo-case-create-0001","intake":{"ideaSummary":"A sample workflow helper","targetUser":"Independent tutors","problem":"Session notes take time","proposedSolution":"A structured note template"},"hypotheses":[{"claim":"Tutors spend time rewriting session notes"}]}' \
  | npm run --silent idea:research:cli -- case-create
```

Use IDs and revisions returned in each envelope for later commands. A plan may
contain a caller-supplied `suppliedPlan`; otherwise the application generates a
bounded local plan. Model-generated hypothesis suggestions are opt-in through
`requestHypothesisSuggestions`. `start` waits up to 15 minutes by default and
prints the final result page envelope. `--poll-interval-ms` and
`--wait-timeout-ms` tune that wait.
Ctrl-C requests durable cancellation for the run and waits briefly for cleanup;
exit status 130 means the CLI was interrupted, while 124 means its wait deadline
elapsed. If cleanup cannot confirm a terminal state, stderr reports the last
observed status. The CLI does not detach a run it owns.

`result` accepts `--format json|markdown`; the stdin object's `limit` and
`cursor` fields control bounded pagination. Markdown is returned in the result
envelope, not written to an arbitrary filesystem path. With providers
unconfigured or without usable original-source evidence, a completed run can
correctly report `insufficient_evidence` and coverage gaps. `--help` is safe to
run without opening or initializing a workspace.

Exit statuses are stable: 0 success; 2 validation; 3 not found; 4 conflict; 5
busy; 6 provider unavailable; 7 limit exceeded; 8 access denied; 9 rate limited;
64 command usage; 65 stdin input; 70 internal/run failure; 124 wait timeout; and
130 Ctrl-C interruption. The envelope carries the shared error code and
validation details.

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
and makes it eligible for exploration.

Research drafts live in SQLite run metadata and are visible through
`idea:explain`. Approval through this CLI does not export Markdown. The library
exposes `publishResearchArtifact` in `lib/review.ts` as a separate publication
path; no current CLI command invokes it. `idea:artifacts` lists records created
through that path, so a newly approved CLI draft need not appear in that list.
Exploration briefs are written to local Markdown files.

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
