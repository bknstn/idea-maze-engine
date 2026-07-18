# Review-Gate Evidence Alignment Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Stop high raw opportunity scores from reaching research/review when their sources are irrelevant, duplicated, promotional, contradictory, or unsupported by direct buyer evidence.

**Architecture:** Keep the existing deterministic duplicate/evidence gates, but change eligibility from “three unique source rows with generic pain words” to “grounded, thesis-aligned, independent buyer evidence.” Add a structured source-to-thesis evidence card before research, validated against exact source quotes; persist a quality-adjusted automation score separately from the raw market score. Re-evaluate existing review-gate drafts and expose diagnostics using the same evaluator.

**Tech Stack:** TypeScript, SQLite/better-sqlite3, Vitest, existing centralized LLM routing in `src/idea-maze/scripts/lib/llm.ts`.

---

## Observed failure and acceptance baseline

A live replay of the current `evaluateEvidenceQuality()` against the ten runs rejected on 2026-07-18 produced:

- `9/10` classified as `review_eligible` by the current gate.
- Unique source rows were counted as independent buyer evidence even when unrelated to the thesis.
- Generic words such as `hard`, `problem`, and `struggle` made unrelated posts count as direct pain.
- Self-promo only blocked a candidate when at least 50% of all linked sources were promotional.
- WTP/time-loss/workaround signals from unrelated sources could unlock the two-source exception.
- `content_hash` short-circuited normalized-text deduplication, so crossposts with different hashes could appear independent.
- The duplicate gate compared only against already-rejected opportunities and did not collapse duplicate candidates in the same active/review-gate cohort.
- Draft validation checked JSON/prose shape, not whether cited sources supported or contradicted the thesis.

Regression acceptance criteria:

- All ten rejected fixtures must be `needs_more_evidence` or `auto_reject`.
- A known strong bookkeeping/client-document fixture must remain `review_eligible`.
- No promo source may count as independent buyer evidence.
- No search/Tavily source may count as buyer evidence.
- Rich evidence must come from a source that is itself relevant, direct, non-promotional, and grounded.
- A grounded contradiction blocks automatic review-gate entry.

---

### Task 1: Add rejected-batch regression fixtures

**Objective:** Turn the reviewed failures into permanent tests before changing behavior.

**Files:**
- Create: `src/idea-maze/scripts/lib/review-gate-regression-fixtures.ts`
- Modify: `src/idea-maze/scripts/lib/evidence-quality.test.ts`
- Modify: `src/idea-maze/scripts/lib/duplicate-opportunities.test.ts`

**Steps:**
1. Add compact fixtures for `anki-review`, `actually-pdf`, `account-business`, `data-oura`, `out-know`, `out-pipeline`, `first-time`, `out-people`, `business-people`, and `workout-back` using short representative source excerpts, source roles, and expected reject reasons.
2. Add one positive control based on a sharp bookkeeping-specific pain with three independent direct sources.
3. Write failing parameterized tests asserting all ten rejected fixtures do not reach `review_eligible`.
4. Add duplicate tests for same-thesis active candidates and crossposts with different `content_hash` values but equivalent normalized bodies.
5. Run:
   ```bash
   npx vitest run src/idea-maze/scripts/lib/evidence-quality.test.ts src/idea-maze/scripts/lib/duplicate-opportunities.test.ts
   ```
   Expected: new regression assertions fail before implementation.

---

### Task 2: Make deterministic source quality conservative

**Objective:** Stop treating arbitrary unique source rows and broad pain words as buyer evidence.

**Files:**
- Modify: `src/idea-maze/scripts/lib/evidence-quality.ts`
- Modify: `src/idea-maze/scripts/lib/evidence-quality.test.ts`

**Steps:**
1. Split source counters into `uniquePrimarySources`, `nonPromoPrimarySources`, `directBuyerPainSources`, and `thesisAlignedBuyerSources`; do not expose raw uniqueness as `independentBuyerSourceCount`.
2. Never count `promo_sources`, `search`, or `tavily` rows as independent buyer evidence.
3. Require three thesis-aligned direct buyer sources, or two only when a WTP/time-loss/current-workaround signal occurs in those same two aligned sources.
4. Remove broad standalone matches such as `hard`, `problem`, and `struggle`; require first-person/operational context and a concrete object/workflow.
5. Compute both a content-hash key and a normalized body/title signature. Treat either match as duplicate; do not let a differing hash bypass normalized deduplication.
6. Add reason labels: `irrelevant_sources`, `promo_only_support`, `weak_direct_pain`, `rich_signal_not_aligned`, and `crosspost_duplicates`.
7. Run the focused evidence tests; expected: rejected fixtures are blocked and the positive control passes.

---

### Task 3: Add grounded source-to-thesis evidence cards

**Objective:** Detect relevance and contradiction instead of relying only on keyword regexes.

**Files:**
- Modify: `src/idea-maze/scripts/lib/llm.ts`
- Modify: `src/idea-maze/scripts/lib/prompts.ts`
- Create: `src/idea-maze/scripts/lib/evidence-alignment.ts`
- Create: `src/idea-maze/scripts/lib/evidence-alignment.test.ts`

**Steps:**
1. Add a centralized structured call that receives opportunity title/thesis plus primary sources and returns one record per source:
   - `relation`: `supports | contradicts | context | irrelevant | promo`
   - `buyer_present`
   - `pain_quote`, `wtp_quote`, `time_loss_quote`, `workaround_quote`
   - short reason
2. Validate every non-null quote as an exact normalized substring of the cited source. Reject ungrounded model claims.
3. Count only `supports` records with grounded buyer/pain evidence.
4. Treat any grounded `contradicts` primary source as `needs_more_evidence` with reason `contradicting_primary_source` unless at least three stronger independent supporting sources remain and the contradiction is explicitly resolved.
5. If the alignment call is unavailable or invalid, fail conservatively to `needs_more_evidence`; do not fall back to permissive regex-only review eligibility.
6. Add tests for:
   - the supplier-payment source saying its receipt is already “clean enough”;
   - an unrelated post containing generic pain words;
   - a self-promo source describing the exact product;
   - a valid direct buyer quote;
   - fabricated/non-substring quotes.
7. Run the focused alignment tests and typecheck.

---

### Task 4: Integrate aligned evidence before research

**Objective:** Ensure research drafting cannot begin until evidence clears deterministic and alignment gates.

**Files:**
- Modify: `src/idea-maze/scripts/process-opportunities.ts`
- Modify: `src/idea-maze/scripts/lib/opportunity-policy.ts`
- Modify: corresponding tests

**Steps:**
1. Run cheap duplicate and deterministic gates first.
2. Run evidence alignment only for candidates that survive cheap gates.
3. Persist the evidence card and counters in opportunity/run event metadata.
4. Add `automation_score = min(final_score, deterministic_cap, alignment_cap)` to event/diagnostic output; preserve raw `final_score` for audit.
5. Require `review_eligible` and automation score above threshold before `researchOpportunity()`.
6. Archive/quarantine failed candidates with explicit reasons rather than leaving them active with a misleading high score.
7. Preserve `IDEA_MAZE_DISABLE_QUALITY_GATE=1` as an emergency bypass and record when it is used.
8. Run focused policy/process tests.

---

### Task 5: Expand duplicate handling across the current cohort

**Objective:** Prevent parallel variants such as `out-know`, `out-people`, and `out-pipeline` from simultaneously reaching review.

**Files:**
- Modify: `src/idea-maze/scripts/lib/duplicate-opportunities.ts`
- Modify: `src/idea-maze/scripts/lib/duplicate-opportunities.test.ts`
- Modify: `src/idea-maze/scripts/process-opportunities.ts`

**Steps:**
1. Compare candidates against `rejected`, `review_gate`, `approved`, and active shortlisted candidates, not only rejected rows.
2. Distinguish outcomes:
   - duplicate of rejected → archive as `duplicate_rejected_opportunity`;
   - duplicate of active/review-gate → attach evidence to the canonical opportunity and skip a new research run;
   - duplicate of approved → preserve approval and attach new evidence without changing lifecycle.
3. Use normalized thesis/title tokens plus normalized source signatures and shared source IDs.
4. Pick a deterministic canonical row: sticky approved first, then oldest review-gate/active row.
5. Add same-batch regression tests for all three addiction-recovery variants.

---

### Task 6: Revalidate existing drafts and improve diagnostics

**Objective:** Prevent stale pre-gate drafts from remaining in the human-review queue.

**Files:**
- Modify: `src/idea-maze/scripts/inspect-review-gate-quality.ts`
- Create: `src/idea-maze/scripts/revalidate-review-gate.ts`
- Modify: `package.json`
- Add tests for read-only and apply modes

**Steps:**
1. Make `idea:inspect:review-gate` evaluate both active candidates and existing `draft_ready`/`review_gate` rows using the exact production evaluator.
2. Report raw score, automation score, aligned buyer-source count, promo/irrelevant/contradictory counts, duplicate match, and reason labels per candidate.
3. Add `idea:revalidate:review-gate -- --json` as read-only by default; require `--apply` for lifecycle changes.
4. In apply mode, preserve audit history and mark failed drafts `needs_more_evidence`/archived with a `review_gate.revalidated` event; never delete drafts or artifacts.
5. Fix `average_final_score_recent_rejected_runs` so it actually includes `runs.status='rejected'` and joins opportunities by both numeric ID and slug.

---

### Task 7: Use first-class rejection reasons for calibration

**Objective:** Make human review teach the gate why candidates failed.

**Files:**
- Modify: `src/idea-maze/scripts/lib/human-review.ts`
- Modify: `src/idea-maze/scripts/lib/human-review-cli.ts`
- Modify: `src/idea-maze/scripts/lib/human-review.test.ts`
- Modify: `src/idea-maze/scripts/inspect-review-gate-quality.ts`

**Steps:**
1. Add/standardize reasons needed by these batches: `contradicted_thesis`, `promo_only_support`, `irrelevant_sources`, and `duplicate_cluster` while retaining existing labels.
2. Support multiple `--reason` values in `idea:review` and document batch usage.
3. Persist reasons in `runs.metadata_json.human_review`, `approvals.notes`, and `feedback_features`.
4. Show top reasons and false-pass rate in diagnostics.
5. Add a rolling metric: among the last 30 human-reviewed runs, how many were rejected despite being production-evaluator `review_eligible` at creation time.

---

### Task 8: Verify on production-shaped data without mutating it

**Objective:** Prove the new gate improves precision before rollout.

**Steps:**
1. Run:
   ```bash
   npm run typecheck
   npx vitest run \
     src/idea-maze/scripts/lib/evidence-quality.test.ts \
     src/idea-maze/scripts/lib/evidence-alignment.test.ts \
     src/idea-maze/scripts/lib/opportunity-policy.test.ts \
     src/idea-maze/scripts/lib/duplicate-opportunities.test.ts \
     src/idea-maze/scripts/lib/human-review.test.ts
   npm test
   ```
2. Run the diagnostics read-only:
   ```bash
   IDEA_MAZE_HOME=/workspace/idea-maze npm run --silent idea:inspect:review-gate -- --json
   IDEA_MAZE_HOME=/workspace/idea-maze npm run --silent idea:revalidate:review-gate -- --json
   ```
3. Replay the ten rejected fixtures and the positive controls.
4. Acceptance:
   - `10/10` rejected fixtures blocked;
   - positive control remains eligible;
   - no database writes in read-only diagnostics;
   - full test suite passes.
5. Review the diff and runtime diagnostics before committing. Do not push without Kostya’s explicit approval.
