# ADR 0021: Run a frozen offline research evaluation through the application

- Status: Accepted
- Adopted: 2026-10-29

## Context

A frozen synthetic corpus needs execution through the actual run coordinator,
collector, evidence mapper and assessment service. Fake assessments and
expectation-driven provider answers would conceal integration failures.

## Decision

Run tuning by default through `createResearchRuntime`, using isolated SQLite
workspaces and offline provider doubles. The generic interpretation double reads
hypothesis/source text; expected labels are used only by the scorer. Require an
explicit acknowledgment of the exact evaluator/policy/corpus fingerprint before
loading the holdout split. Preserve its first observed result without tuning.

Report exact quotation provenance, actual assessment citations separately from
emitted excerpts, missed in-scope counterevidence, withheld source groups,
coverage confusion, terminal states and nullable usage. Include assessment text
for independent manual review. Runtime summaries use the midpoint median and
nearest-rank p95, separated by terminal status. Unknown usage and unreviewed
unsupported conclusions remain null.

## Consequences

The checked-in first report records poor semantic agreement from the generic
mock and a planning failure in one budget scenario. These are visible limitations,
not passing scenarios. Zero quotation provenance errors cannot validate a
relationship interpretation. The harness reports failures rather than promising
that all scenarios execute successfully; the current query-budget fixture still
needs a future, separately versioned evaluation correction.

These runs establish neither model accuracy nor product usefulness. They are
synthetic application policy/provenance regressions. A future implementation or
evaluator change informed by holdout results requires retiring that holdout and
reviewing a new version. Human usefulness requires the separate pilot.

## Implementation references

- `src/idea-maze/research/evaluation/runner.ts` and `evaluation.test.ts`
- `src/idea-maze/scripts/evaluate-hypothesis-research.ts`
- `docs/evaluations/hypothesis-research-v1.md` and its full JSON reports
- [Evaluation harness task](https://github.com/bknstn/idea-maze-engine/issues/23)
