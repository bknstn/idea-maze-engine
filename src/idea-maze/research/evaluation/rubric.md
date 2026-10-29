# Hypothesis research evaluation rubric

**Status:** frozen rubric and fixture expectations, pending engine integration; no engine execution or performance result is included.

**Rubric version:** `1.0.0`<br>
**Case set:** `idea-maze-hypothesis-research-usefulness` `1.0.0`<br>
**Cases:** 8 tuning, 10 holdout (18 total). The TypeScript manifest records exact case IDs and a SHA-256 digest over versions, split membership, source text, and expected behavior.

## Purpose and limits

This rubric checks whether an eventual research run follows its evidence, provenance, coverage, and run-control contracts on curated synthetic inputs. It does not measure market demand, forecast adoption, or establish that a product is useful to real users. The cases are not a representative sample of people, markets, or web content.

The fixtures and this rubric are separate from engine outputs. Integrity tests check that fixture references and expectations are internally grounded and frozen; they do not execute a model, compare a stub to gold data, or count mock behavior as engine validation. Full usefulness evaluation remains pending the T09 assessment and T11 execution path.

## Frozen case splits

The tuning and holdout records are stored in separate source files. Tuning cases may be used while correcting the evaluator or engine. Holdout expectations are frozen before tuning and must be reviewed by the coordinator before first use. Do not tune against holdout results. If a holdout result is inspected and then influences implementation or evaluator changes, retire that holdout version and review a new one.

Current coverage includes:

- support, opposition, mixed evidence, and empty search results;
- an inaccessible original and provider outage;
- accepted suggestion provenance and a suggestion that remains unaccepted, separately from promotional-source contamination;
- duplicate pages and dependent syndicated sources;
- fabricated and stale quotations, plus a misleading discovery snippet;
- ambiguous user and buyer identity;
- instruction-like source text;
- promotional copy that is only evidence that a vendor made a claim;
- query-budget exhaustion and cancellation with explicit partial-coverage boundaries.

Each source uses `https://example.com/` and fictional text. Search snippets carry `assessmentEligible: false`. A snippet or marketing statement may provide retrieval context, but it cannot become a verified customer quotation by repetition or citation.

## Evaluation procedure after integration

1. Verify the case-set digest and rubric version in the report. Record the exact engine revision and evaluator revision.
2. Run tuning cases first through the actual T09/T11 application/execution path. Capture the structured run, its evidence links, terminal status, gaps, runtime, and usage. Do not substitute a fake assessment implementation.
3. Make and record any tuning changes before opening holdout results. Then run the holdout split once for that frozen engine/evaluator revision.
4. Keep contract tests and mock-provider tests in a separate section. They may verify interfaces, but their rows do not contribute to the engine evaluation counts.
5. Inspect each holdout output against its independent expected behavior. For free-text conclusions, use a reviewer who does not change the expected labels while reading the output. Record the adjudication and any disagreement; do not silently rewrite the fixture to make a result pass.

If the engine cannot execute, report an integration or harness failure and the exact stopping point. Do not publish a synthetic pass rate.

## Metrics

Report tuning and holdout separately, with numerator, denominator, and case IDs behind every aggregate.

### Evidence provenance errors

Count every output evidence link that fails any of these checks: its source ID is in the run's captured source set; the returned source version and text hash match that set; zero-based UTF-16 offsets slice exactly to the returned quote; the quote matches the original; and the link has the contract's verified-original state. A discovery snippet cited as assessment-eligible is an error. Report `invalid links / all emitted evidence links`; also list snippet misuse separately. If no links were emitted, report the rate as unavailable with denominator zero, not as a perfect score.

### Unsupported conclusions

Review each distinct factual conclusion in the assessment summary and rationale, including buyer identity, frequency, willingness to pay, breadth, and claimed solution fit. Count a conclusion unsupported if no eligible verified evidence supports that exact scope, or if it depends on instruction-like or promotional source text as though it were user evidence. Report `unsupported conclusions / conclusions reviewed`, with the coded items and evidence references. A conservative `insufficient_evidence` result is not an unsupported conclusion merely because it is cautious.

The output contract does not provide a calibrated numeric demand score. Do not invent one for this report.

### Missed known counterevidence

Count an expected counterevidence source as missed only when the fixture marks it in-scope for the run and the returned assessment omits its challenging relationship. Denominator is the number of in-scope gold counterevidence independence groups, not the raw number of URLs. Duplicate or syndicated copies in one group count once.

`withheldCounterEvidenceSourceIds` and `executionScope` document gold counterevidence outside the executed collection scope, such as a query prevented by the budget or cancellation before the fetch. The budget and cancellation fixtures identify the reachable source, the withheld source, and the stop event. Withheld evidence is not a miss when the run reports the required `budget_exhausted` or `cancelled` gap and does not claim comprehensive coverage. Report withheld source/group counts separately so partial coverage remains visible.

### Coverage classification

For each run, compare the distinct emitted `CoverageGapReason` values with the fixture's required reasons. Report exact per-case set agreement and a per-reason confusion table (true positive, false positive, false negative). Do not treat provider failure, inaccessible originals, empty results, a budget stop, and cancellation as interchangeable. The provider-outage case expects stopping reason `provider_unavailable` and an insufficient-evidence assessment; an outage is a coverage gap, not evidence against the hypothesis.

### Outcome and source-independence diagnostics

Report exact outcome agreement for cases where an assessment is expected. `null` means the frozen behavior expects no final assessment, not a wrong outcome. Separately count (a) unaccepted suggestions that were treated as active or run, (b) accepted suggestion origins that lost their source suggestion ID, (c) sources/snippets incorrectly used as evidence, and (d) excess independent support groups caused by duplicates or syndication. Keep these diagnostics visible even when the aggregate outcome happens to match.

### Runtime and available usage

Use the run's measured `elapsedMilliseconds` for runtime, reporting case values plus median and 95th percentile. Break out completed, failed, cancelled, and not-started cases; no-runtime cases are unavailable, not zero milliseconds.

Report observed search-request and fetched-page counts. For model input tokens, model output tokens, and provider cost, preserve `null` as unreported. For each field report the total among runs that supplied a number, the number of reporting runs, and the number of unreported runs. Never coerce missing usage to zero or compare totals without showing availability. A reported numeric zero remains zero.

## Reproducible report fields

Every eventual report should include:

- case-set ID, case-set version, expected-behavior SHA-256, and rubric version;
- engine revision, evaluator revision, run IDs, run date, and split;
- whether each row used the real application/execution path or a mock (only real-path rows enter the engine metrics);
- expected and observed status, stopping reason, coverage gaps, outcome, evidence IDs, source groups, elapsed time, and usage;
- metric numerators/denominators, per-case findings, and any manual adjudication notes;
- explicit statement that synthetic results do not establish real-world demand or user usefulness.

Do not store live credentials, personal data, real customer/source content, or private operational details in evaluation artifacts. The present corpus is synthetic and should stay that way.
