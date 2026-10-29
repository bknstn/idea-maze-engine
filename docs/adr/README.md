# Architecture decision records

These records explain the implemented design and its tradeoffs. They were
reconstructed from Git history and existing implementation plans on 2026-10-22;
adoption dates refer to implementation commits, not earlier proposal dates.
Numbers start at 0000 and follow the implementation timeline. Same-day ordering
uses the order of changes on the main branch.

| Record | Adopted | Status |
| --- | --- | --- |
| [0000: Local CLI and SQLite pipeline](0000-local-cli-and-sqlite.md) | 2026-05-14 | Accepted |
| [0001: Topic-aware deterministic harvest scoring](0001-topic-aware-harvest-scoring.md) | 2026-05-28 | Accepted |
| [0002: Evidence quality before automated research](0002-evidence-quality-gates.md) | 2026-06-05 | Accepted |
| [0003: Calibrate review against source quality](0003-review-gate-calibration.md) | 2026-06-14 | Accepted |
| [0004: Explore approved opportunities separately](0004-approved-opportunity-exploration.md) | 2026-06-21 | Accepted |
| [0005: Keep artifacts local without repository mirroring](0005-local-artifacts-without-mirroring.md) | 2026-06-21 | Accepted |
| [0006: First-class CLI review with rejection reasons](0006-human-review-command.md) | 2026-07-06 | Accepted |
| [0007: Ground research eligibility in thesis-aligned evidence](0007-thesis-aligned-source-evidence.md) | 2026-07-18 | Accepted |
| [0008: Rotate Reddit harvest work across runs](0008-rotating-reddit-harvest.md) | 2026-08-02 | Accepted |
| [0009: Inspect artifact retention without deleting files](0009-retention-inspection.md) | 2026-08-09 | Accepted |
| [0010: Route model work by task behind provider adapters](0010-provider-neutral-model-routing.md) | 2026-08-15 | Accepted |
| [0011: Verify source excerpts against visible body windows](0011-versioned-source-excerpts.md) | 2026-09-24 | Accepted |
| [0012: Track Reddit ingestion ranges and coverage gaps](0012-reddit-coverage-accounting.md) | 2026-09-25 | Accepted |
| [0013: Optional shadow evidence assessment](0013-shadow-evidence-assessment.md) | 2026-09-25 | Accepted |
| [0014: Isolate hypothesis research from discovery scoring](0014-hypothesis-research-foundation.md) | 2026-10-29 | Accepted |
| [0015: Assess claims from verified evidence and bound report pages](0015-claim-assessments-and-bounded-reports.md) | 2026-10-29 | Accepted |
| [0016: Require an explicit single-owner HTTP policy](0016-single-owner-http-policy.md) | 2026-10-29 | Accepted |
| [0017: Own research runs independently of client connections](0017-durable-research-run-ownership.md) | 2026-10-29 | Accepted |
| [0018: Compose a bounded hypothesis research application](0018-bounded-hypothesis-research-application.md) | 2026-10-29 | Accepted |
| [0019: Expose hypothesis research through a shared-application CLI](0019-shared-application-cli.md) | 2026-10-29 | Accepted |
| [0020: Bind MCP transports to the real research runtime](0020-mcp-runtime-entrypoint.md) | 2026-10-29 | Accepted |
| [0021: Run a frozen offline research evaluation through the application](0021-offline-research-evaluation.md) | 2026-10-29 | Accepted |
| [0022: Verify one research workflow across CLI and MCP](0022-cross-interface-research-workflow.md) | 2026-10-29 | Accepted |

The [discovery-gate recalibration proposal](../proposals/discovery-gate-recalibration.md)
is not an accepted decision and does not describe current policy. Current usage
belongs in the [README](../../README.md), [configuration](../configuration.md),
and [CLI guide](../cli.md), rather than in implementation transcripts.

For future design changes, append a numbered ADR with context, decision,
consequences, adoption date, and implementation reference. If a decision is
superseded, link both records and preserve the earlier rationale. Keep personal
names, host-specific commands, runtime datasets, and credentials out of ADRs.
