# Hypothesis research offline evaluation v1

Run date: 2026-10-29. The synthetic tuning and holdout reports are [tuning-v1.json](./tuning-v1.json) and [hypothesis-research-holdout-v1.json](./hypothesis-research-holdout-v1.json). The holdout file contains the complete per-case observations and assessment text for manual review.

## Scope and frozen inputs

This is an offline policy and provenance regression through the real research application and assessment path, using mocked search, source-fetch, and model providers with isolated SQLite databases. The mock interpretation is generic and text-derived. It does not read fixture expected outcomes or expected evidence. These results do not measure model interpretation accuracy, suggestion accuracy, market demand, or product usefulness. No live provider or network calls were made.

**Engine usefulness evidence: no.** This run is synthetic mocked-provider policy/provenance evidence only; it must not be presented as an engine usefulness result.

| Input | Frozen value |
| --- | --- |
| Engine revision | `9fdee9a816ed828153bc1d9a490a30a64c902a9f` |
| Case set | `idea-maze-hypothesis-research-usefulness` v1.0.0 |
| Frozen corpus SHA-256 | `13b7ccf965043c8dec05f7189b057308c996de9bd01171fb25dfd141bf517c26` |
| Rubric | v1.0.0 |
| Evaluation policy SHA-256 | `4842a94d53932694a1531232503b19cea8f1f0046e929025c113c98c99fc6914` |
| Runner SHA-256 | `f2f400c6dc9353764d2cae9e75061814a4c2c8315b3c70b2f723c91bda117882` |
| Combined freeze SHA-256 | `220a9bea86bce0d87ba1196e4d948d2c060650a681d1352e8b47663c581a1106` |

The holdout was executed once against this freeze. No engine, evaluator, classifier, corpus, or rubric changes were made after observing the holdout.

## Tuning split

The 8 tuning cases completed. Structural comparisons were: terminal status 8/8, stopping reason 8/8, assessment expectation 8/8, outcome 6/8, coverage-reason set 8/8, and hypothesis origin 8/8. Suggestion disposition was 1/1. Provenance errors were 0/9; expected-citation recall and expected-evidence emission were each 5/7; uncited verified evidence was 0/9; unexpected verified evidence was 4/9; snippet misuse was 0/9; and known counterevidence groups missed were 2/3 (`t03-mixed-evidence`, `t08-fabricated-quotation`). These are metric counts, not a composite pass result.

The tuning report records 16 search requests and 10 fetched pages. Model token and provider cost values are null for all 8 runs because the mocked provider did not report them. Measured completed runtime had a 15 ms median and 34 ms p95; these local mock timings are not performance guarantees.

## Holdout split

There were 7 completed cases, 2 not started, and 1 cancelled. Terminal status, stopping reason, and assessment-expectation comparisons were each 9/10. Outcome agreement was 1/8: `h06-provider-outage` matched; six observed outcomes differed from their expected outcomes, and `h07-budget-with-counterevidence-pending` had no observed outcome because planning failed. Coverage-reason-set agreement was 8/10. Hypothesis origin was 10/10, and the single suggestion-disposition case was 1/1.

Structural evidence results were: provenance errors 0/8; expected-citation recall 0/8; expected-evidence emission 0/8; uncited verified evidence 1/8 (`h04-source-instruction-injection`); unexpected verified evidence 8/8; snippet misuse 0/7; and known counterevidence groups missed 2/2 (`h01-stale-quotation`, `h02-misleading-snippet`). Coverage reason counts were `provider_unavailable` 1 true positive, `cancelled` 1 true positive, `budget_exhausted` 1 false negative, and `no_independent_sources` 1 false negative.

Manual inspection against the frozen originals found semantically wrong evidence relationships in `h01`, `h02`, `h03`, `h05`, and `h10`; these are diagnostics of the generic mock interpretation, not measured model behavior. In `h10`, a vendor-copy excerpt is treated as support when it should be context, a critical limitation of this mocked regression. In `h04`, the context excerpt misses support, although the assessment does not follow the injected instruction. Zero quotation-provenance errors only says the emitted quotations map back to source text; it does not validate the interpretation or conclusion.

`h07-budget-with-counterevidence-pending` failed at planning because its configured maximum is one query while the frozen case supplies two queries; the planner rejects the over-limit plan. The report records the case as not started with no assessment, and as a harness failure rather than successful engine behavior. It was not retried. The other non-started case, `h09-unaccepted-suggestion`, remained unaccepted as expected and also has no final assessment. Source grouping is heuristic: authorship independence is not established by these synthetic sources, and some group-count comparisons are not applicable or disagree.

Manual unsupported-conclusion review is pending for 7 cases. The report includes each assessment summary, rationale, next experiment, and claim-level rationale and citation IDs so a reviewer can inspect them. Automated reviewed-conclusion and unsupported-conclusion counts are null; no unsupported-claim score is inferred. Cancelled and not-started cases have no assessment to review.

Measured runtime by terminal status: completed (7 cases), median 15 ms and p95 33 ms; cancelled (1), median 11 ms and p95 11 ms; not started (2), both percentiles null because no runtime was measured. The report records 15 search requests and 10 fetched pages across 8 reporting runs. Model input/output tokens and provider cost are null for all 8 runs because they were not reported by the mock provider. Runtime values are local mock measurements only.

## Interpretation boundary

The runner exercised the application path and recorded both completed cases and the `h07` planning failure, but the entire holdout scenario set was not successfully executed and release quality is not validated. These comparisons exercise the runner, orchestration, evidence provenance, citation handling, stopping behavior, and reporting against synthetic fixtures. The generic mocked interpretation explains the outcome mismatches and is not a proxy for model quality. Independent manual review of the included assessment text remains necessary for any claim about unsupported conclusions. The counts should not be presented as an overall usefulness score or pass rate.
