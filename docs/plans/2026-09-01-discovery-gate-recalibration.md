> Historical proposal preserved from VPS on 2026-09-27. This archive is not an instruction to implement or enable the pipeline; later accepted scope takes precedence.

# Idea Maze Discovery-Gate Recalibration Implementation Plan

> **For Hermes:** Use the `subagent-driven-development` skill to implement this plan task-by-task. Keep the scheduled Idea Maze job paused until the shadow backtest and an explicitly approved validation run pass.

**Goal:** Restore useful Idea Maze discovery recall without returning to the noisy pre-gate artifact stream, targeting a measurable 10–20% review-candidate rate rather than the current 0%.

**Architecture:** Separate terminal rejection from incomplete evidence. Deterministic evidence checks remain the primary quality filter, but `needs_more_evidence` becomes a non-terminal, re-evaluable state. LLM evidence alignment becomes advisory/ranking input except for grounded contradictions. A read-only historical backtest must calibrate the policy before any live pipeline run or database mutation.

**Tech Stack:** TypeScript, Node.js, Vitest, SQLite (`better-sqlite3`), existing Idea Maze CLI/run-event contracts.

---

## Current evidence and problem statement

Read-only inspection on 2026-09-01 found:

- Last research draft: **2026-07-11**.
- Stricter evidence alignment was introduced on **2026-07-18** (`766d9fa`).
- Since then, **122** high-score candidates were evaluated.
- Final disposition: **122/122 `needs_more_evidence`**, **0 review-eligible**.
- Deterministic gate: 103 failed, 19 passed.
- LLM alignment gate: all 19 deterministic survivors failed.
- Aligned buyer-source distribution among the 122 candidates:
  - 0 sources: 46
  - 1 source: 50
  - 2 sources: 12
  - 3+ sources: 14
- Dominant reasons:
  - `insufficient_independent_buyer_sources`: 103
  - `rich_signal_not_aligned`: 59
  - `promo_sources`: 40
  - `no_direct_buyer_pain`: 39
  - `weak_direct_pain`: 39
- Latest pipeline still ingested 25 posts, created 84 insights, refreshed 49 opportunities, and then archived every high-score candidate it evaluated.

Conclusion: ingestion and extraction still produce signals, but two serial veto gates have reduced discovery throughput to 0%. Tavily exhaustion is a separate enrichment constraint and does not explain the July cutoff.

## Design principles

1. **Discovery is not final validation.** A candidate should not need investment-grade evidence to enter human review.
2. **Terminal and non-terminal outcomes must differ.** `needs_more_evidence` must not be implemented as `archived`.
3. **Keep obvious-junk precision.** Duplicate-rejected ideas, promo-only clusters, generic wrappers, and grounded contradictions remain hard stops.
4. **Prefer ranking over vetoes.** Weak or incomplete evidence lowers priority; it should not always destroy the candidate.
5. **No paid APIs for calibration.** Backtests and diagnostics must run from stored DB evidence with network/LLM calls disabled.
6. **Measure the funnel.** Every run must expose candidate, hard-reject, deferred, review-eligible, and drafted counts.
7. **Preserve human decisions.** Approved/rejected lifecycle states remain sticky.

## Proposed policy v2

### Terminal archive

Archive only when at least one explicit hard-stop condition is met:

- duplicate of a rejected opportunity with sufficiently strong duplicate evidence;
- promo-only or promo-dominated evidence with no credible non-promo buyer signal;
- generic AI-wrapper/noise cluster;
- no credible direct buyer pain after evaluating the available primary evidence;
- grounded unresolved contradiction that invalidates the thesis;
- existing explicit human rejection.

Each archive must record one stable `archive_reason` and supporting metrics.

### Non-terminal `needs_more_evidence`

Keep the opportunity active and re-evaluable when:

- it has one credible thesis-aligned buyer-pain source but lacks corroboration;
- it has two aligned buyer sources but lacks a rich WTP/time-loss/workaround signal;
- the deterministic gate passes but LLM alignment is unavailable, invalid, or merely insufficient;
- evidence is mixed but there is no grounded contradiction or hard-stop condition.

Use existing lifecycle/state primitives where possible. Prefer an active `shortlisted` or `scored` opportunity plus structured evidence metadata/events over adding a new schema enum unless tests prove a dedicated lifecycle stage is required.

### Review eligibility

A candidate can enter the bounded review/research queue when either:

- it has 2+ independent thesis-aligned buyer-pain sources; or
- it has 1 aligned buyer-pain source plus at least one aligned rich signal (WTP/budget, quantified time loss, or concrete workaround).

LLM alignment should adjust priority and add warnings. It should veto only a grounded unresolved contradiction, not `insufficient_aligned_buyer_sources` alone.

### Throughput control

- Keep the existing maximum of 3 new research runs per pipeline run.
- Rank eligible candidates by evidence tier, final score, aligned buyer-source count, rich-signal count, and freshness.
- Optionally reserve at most 1 of the 3 slots for the strongest non-terminal exploratory candidate.
- Target a historical pass/review rate of **10–20%** over the post-2026-07-18 candidate corpus.
- A 0% or >30% shadow pass rate blocks rollout and requires recalibration.

---

## Task 1: Encode policy-v2 outcomes independently of lifecycle mutation

**Objective:** Introduce an explicit decision model that distinguishes hard rejection, non-terminal evidence accumulation, and review eligibility.

**Files:**
- Modify: `src/idea-maze/scripts/lib/evidence-quality.ts`
- Modify: `src/idea-maze/scripts/lib/opportunity-policy.ts`
- Test: `src/idea-maze/scripts/lib/evidence-quality.test.ts`
- Test: `src/idea-maze/scripts/lib/opportunity-policy.test.ts`

**Steps:**

1. Write failing table-driven tests for:
   - one aligned pain source → non-terminal `needs_more_evidence`;
   - one aligned pain source plus rich aligned signal → review eligible;
   - two aligned pain sources → review eligible;
   - zero direct buyer pain → terminal rejection;
   - promo-only support → terminal rejection;
   - generic wrapper/noise → terminal rejection;
   - duplicate/crosspost metadata alone does not automatically reject unless duplicate policy marks a rejected canonical;
   - LLM alignment insufficiency lowers priority but does not independently hard-reject;
   - grounded unresolved contradiction remains a hard stop.
2. Add an explicit policy result type, for example:
   - `hard_reject`
   - `needs_more_evidence`
   - `review_eligible`
3. Keep evidence facts (`sourceQuality`, reason labels, score caps) separate from the final action.
4. Preserve `classifyOpportunityScore()` compatibility for callers/tests that only use score buckets.
5. Run focused tests:

```bash
npm test -- src/idea-maze/scripts/lib/evidence-quality.test.ts src/idea-maze/scripts/lib/opportunity-policy.test.ts
```

Expected: all focused tests pass; no network calls.

6. Commit locally on an `agent/` branch only after showing the diff and receiving commit approval.

---

## Task 2: Make LLM alignment advisory except for contradictions

**Objective:** Prevent the second alignment gate from vetoing every deterministic survivor.

**Files:**
- Modify: `src/idea-maze/scripts/lib/review-gate-revalidation.ts`
- Modify: `src/idea-maze/scripts/lib/evidence-alignment.ts`
- Test: `src/idea-maze/scripts/lib/review-gate-revalidation.test.ts`
- Test: `src/idea-maze/scripts/lib/evidence-alignment.test.ts`

**Steps:**

1. Write failing tests proving:
   - deterministic survivor + `insufficient_aligned_buyer_sources` remains review-eligible or non-terminal, not hard-rejected;
   - alignment unavailable/invalid remains non-terminal and records a warning;
   - grounded unresolved contradiction hard-rejects;
   - ungrounded or invalid contradiction quotes cannot hard-reject;
   - search/Tavily cards remain context-only and cannot satisfy buyer-evidence requirements.
2. Split alignment output into:
   - advisory ranking/reason data;
   - explicit hard-stop contradictions.
3. Ensure `evaluateReviewGateCandidate()` exposes both deterministic and advisory alignment details without collapsing all advisory failures into one veto disposition.
4. Run:

```bash
npm test -- src/idea-maze/scripts/lib/evidence-alignment.test.ts src/idea-maze/scripts/lib/review-gate-revalidation.test.ts
```

Expected: all focused tests pass with mocked/no network behavior.

---

## Task 3: Stop archiving incomplete-evidence candidates

**Objective:** Change pipeline mutation semantics so candidates can accumulate evidence across future harvests.

**Files:**
- Modify: `src/idea-maze/scripts/process-opportunities.ts`
- Test: `src/idea-maze/scripts/process-opportunities.test.ts`
- Possibly modify: `src/idea-maze/scripts/lib/opportunity-state.ts`
- Possibly test: `src/idea-maze/scripts/lib/queries.test.ts`

**Steps:**

1. Write failing integration tests for each policy outcome:
   - hard reject → `status='archived'`, lifecycle `archived`, stable archive event/reason;
   - needs more evidence → remains `status='active'`, is not archived, emits `opportunity.needs_more_evidence`;
   - review eligible → shortlisted and considered for the bounded research budget;
   - approved/rejected opportunities remain untouched;
   - repeated evaluation without new sources does not create duplicate research or noisy duplicate events.
2. Replace the current unconditional archive branches at `process-opportunities.ts` around the deterministic and alignment gates.
3. Store enough structured event payload to explain:
   - decision;
   - reason labels;
   - aligned source count;
   - rich aligned signal count;
   - source-set fingerprint or equivalent change detector;
   - whether alignment was advisory, unavailable, or contradictory.
4. Avoid repeated paid alignment work when the source set has not changed. Reuse stored evaluation/event data or skip reevaluation deterministically.
5. Preserve the existing `--limit`/`--all` research budget behavior.
6. Run:

```bash
npm test -- src/idea-maze/scripts/process-opportunities.test.ts
```

Expected: terminal failures archive; incomplete evidence remains active; eligible candidates enter the bounded queue.

---

## Task 4: Add an offline historical shadow backtest

**Objective:** Measure the proposed policy against the 122 post-2026-07-18 evaluations before changing live behavior.

**Files:**
- Create: `src/idea-maze/scripts/backtest-review-gate-policy.ts`
- Create: `src/idea-maze/scripts/backtest-review-gate-policy.test.ts`
- Modify: `package.json`
- Possibly reuse/modify: `src/idea-maze/scripts/inspect-review-gate-quality.ts`

**CLI contract:**

```bash
IDEA_MAZE_HOME=/path/to/idea-maze-state npm run idea:backtest:review-gate -- --since 2026-07-18 --json
```

**Required output:**

- total candidates;
- hard-reject count/rate;
- needs-more-evidence count/rate;
- review-eligible count/rate;
- projected research candidates after per-run budget;
- reason histogram;
- aligned buyer-source histogram;
- deterministic/alignment disagreement matrix;
- candidate slugs grouped by proposed outcome;
- explicit `network_calls: 0` / offline-mode evidence.

**Steps:**

1. Write tests using a temporary SQLite DB and representative run-event fixtures.
2. Read stored source rows and historical events only.
3. Do not call Tavily, OpenAI, or any LLM adapter.
4. Make ordering and JSON output deterministic.
5. Run the backtest against the live read-only DB.
6. Acceptance gate:
   - review-eligible rate between 10% and 20%;
   - hard rejects remain dominant for obvious junk;
   - at least several previously blocked 1–2-source candidates remain non-terminal;
   - zero API calls and zero DB writes.
7. If outside the target range, adjust thresholds and repeat the offline backtest; do not run the pipeline.

---

## Task 5: Improve funnel observability

**Objective:** Make a future 0% funnel visible immediately rather than only through forensic SQL.

**Files:**
- Modify: `src/idea-maze/scripts/pipeline-status.ts`
- Modify: `src/idea-maze/scripts/process-opportunities.ts`
- Test: relevant pipeline-status/observability tests; create a focused test if none exists
- Test: `src/idea-maze/scripts/lib/observability.test.ts`

**Required per-run metrics:**

- high-score candidates;
- hard rejected;
- needs more evidence;
- review eligible;
- duplicate archived/attached;
- LLM alignment advisory failures;
- grounded contradictions;
- deferred due to research budget;
- new drafts created;
- pass rate.

**Steps:**

1. Write tests for structured run-event payloads and status JSON.
2. Add a warning when:
   - at least 20 candidates were evaluated across recent runs and review pass rate is 0%; or
   - pass rate exceeds 30%.
3. Ensure scheduled reports summarize current-run actionable candidates only.
4. Run focused tests and verify JSON output manually against a temporary DB.

---

## Task 6: Full verification before any live run

**Objective:** Prove correctness, offline safety, and lifecycle preservation.

**Steps:**

1. Run focused tests from Tasks 1–5.
2. Run the complete repository checks:

```bash
npm run typecheck
npm test
```

Expected: zero failures.

3. Run the offline backtest twice and compare exact JSON output for determinism.
4. Verify the live DB checksum/serialization is unchanged by the backtest.
5. Inspect the final diff for:
   - accidental Tavily/OpenAI calls;
   - lifecycle regressions;
   - schema migrations that rewrite approved/rejected state;
   - hidden quality-gate bypasses;
   - hard-coded test-only thresholds.
6. Use `requesting-code-review` before commit.
7. Show maintainer:
   - backtest funnel;
   - sample candidates in each outcome;
   - tests/typecheck output;
   - full diff summary.
8. Ask before committing. Do not push without explicit approval.

---

## Task 7: Controlled live validation and scheduler decision

**Objective:** Validate one real pipeline cycle without silently re-enabling recurring spend.

**Preconditions:**

- Tasks 1–6 accepted.
- Tavily behavior explicitly decided: either credits restored or search enrichment disabled/degraded safely.
- Explicit approval for one manual pipeline run.
- Scheduled job remains paused.

**Steps:**

1. Run one manual pipeline cycle with JSON output.
2. Query exact current-run events and report:
   - ingested items;
   - insights;
   - refreshed candidates;
   - hard rejects;
   - non-terminal candidates;
   - review candidates;
   - created drafts;
   - API fallback/errors.
3. Verify no previously approved/rejected opportunity changed lifecycle unexpectedly.
4. Compare live pass rate with the 10–20% shadow target.
5. Keep the cron job paused if the funnel is 0%, >30%, or lifecycle invariants fail.
6. Resume the scheduled job only after explicit approval.

---

## Likely files changed

- `src/idea-maze/scripts/lib/evidence-quality.ts`
- `src/idea-maze/scripts/lib/evidence-quality.test.ts`
- `src/idea-maze/scripts/lib/opportunity-policy.ts`
- `src/idea-maze/scripts/lib/opportunity-policy.test.ts`
- `src/idea-maze/scripts/lib/evidence-alignment.ts`
- `src/idea-maze/scripts/lib/evidence-alignment.test.ts`
- `src/idea-maze/scripts/lib/review-gate-revalidation.ts`
- `src/idea-maze/scripts/lib/review-gate-revalidation.test.ts`
- `src/idea-maze/scripts/process-opportunities.ts`
- `src/idea-maze/scripts/process-opportunities.test.ts`
- `src/idea-maze/scripts/pipeline-status.ts`
- `src/idea-maze/scripts/lib/observability.test.ts`
- `src/idea-maze/scripts/backtest-review-gate-policy.ts`
- `src/idea-maze/scripts/backtest-review-gate-policy.test.ts`
- `package.json`

## Risks and trade-offs

- **Recall may increase noise:** controlled by hard-stop preservation, ranking, and the three-draft budget.
- **Non-terminal candidates may churn forever:** mitigate with source-set fingerprints, evidence-change reevaluation, and age/attempt diagnostics rather than immediate archival.
- **LLM advisory mode may pass weak theses:** deterministic minimum evidence remains mandatory; grounded contradictions remain terminal.
- **Historical backtest may reflect old noisy clusters:** report results by source period/topic and manually inspect samples from each disposition.
- **Tavily outage may hide enrichment quality:** calibration must remain offline; live search is a separate operational decision.
- **Lifecycle migration risk:** avoid schema/state rewrites unless strictly necessary; approved/rejected states must remain sticky.

## Acceptance criteria

- Offline backtest over post-2026-07-18 candidates produces a 10–20% review-eligible rate.
- `needs_more_evidence` candidates remain active and re-evaluable.
- Obvious promo/noise/duplicate-rejected candidates remain terminally archived.
- Deterministic survivors are not all vetoed by LLM alignment.
- Grounded unresolved contradictions still block review.
- Search/Tavily evidence remains context-only for buyer-source counts.
- Backtest makes zero network calls and zero DB writes.
- `npm run typecheck` and full `npm test` pass.
- One approved live validation run reports a non-zero but bounded review funnel.
- Cron remains paused until explicit approval to resume.

## Open questions to resolve during implementation review

1. Should the exploratory slot be always enabled or controlled by an environment/config flag?
2. After how many unchanged evaluations should a non-terminal candidate become dormant rather than remain active?
3. Should `no_direct_buyer_pain` always be terminal, or only after a minimum primary-source count?
4. Should the target pass band be global (10–20%) or vary by source/topic group after enough data accumulates?
5. If Tavily remains unavailable, should research proceed without search enrichment or stop before drafting?
