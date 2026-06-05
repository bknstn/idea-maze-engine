# Review-Gate Quality Filters Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Reduce human-review noise in Idea Maze by preventing source-poor, duplicate, fallback-template, and weak-buyer-signal opportunities from reaching `review_gate` with inflated 9–10 scores.

**Architecture:** Add a deterministic pre-review quality gate between opportunity scoring and research drafting. The gate reads linked source items, existing/rejected opportunity history, and draft metadata; it emits structured reasons, caps scores, archives obvious rejects, and quarantines fallback drafts as `needs_more_evidence`/`archived` instead of `review_gate`. Keep LLM synthesis downstream of evidence checks so prose cannot compensate for bad evidence.

**Tech Stack:** TypeScript, better-sqlite3, Vitest, existing Idea Maze scripts under `src/idea-maze/scripts`.

---

## Acceptance Criteria

- Fallback-template research runs never remain in `review_gate`; they become `needs_more_evidence` or `rejected/archived` with a clear run event.
- Opportunities with fewer than 3 independent sources cannot be selected for new research unless explicitly overridden.
- Opportunities with no direct buyer-pain / WTP / time-loss evidence cannot get a review-gate disposition from score alone.
- Near-duplicates of previously rejected opportunities are auto-archived or skipped before research drafting.
- Human review decisions can store rejection reason labels, not only generic `ignored` taste feedback.
- `npm run typecheck` and focused Vitest suites pass.

---

## Phase 0: Baseline Safety

### Task 1: Create implementation branch

**Objective:** Keep changes isolated and reviewable.

**Files:** none

**Steps:**
1. Run:
   ```bash
   git status --short --branch
   git checkout -b agent/review-gate-quality-filters
   ```
2. Expected: clean branch from `main`; no untracked temp scripts.

**Verification:**
```bash
git status --short --branch
```
Expected: `## agent/review-gate-quality-filters`.

---

## Phase 1: Add deterministic evidence-quality gate

### Task 2: Add evidence quality module skeleton

**Objective:** Introduce a small pure module that classifies opportunity evidence before process/research stages.

**Files:**
- Create: `src/idea-maze/scripts/lib/evidence-quality.ts`
- Create: `src/idea-maze/scripts/lib/evidence-quality.test.ts`

**Types to add:**
```ts
export type EvidenceGateDisposition =
  | 'review_eligible'
  | 'needs_more_evidence'
  | 'auto_reject';

export interface EvidenceSourceSummary {
  id: number;
  source: string;
  title: string | null;
  text: string;
  canonical_url: string | null;
  channel_or_label: string | null;
  content_hash?: string | null;
  metadata_json?: string | null;
}

export interface EvidenceQualityResult {
  adjustedMaxScore: number;
  disposition: EvidenceGateDisposition;
  independentSourceCount: number;
  reasons: string[];
  sourceQuality: {
    directPainCount: number;
    duplicateContentCount: number;
    promoCount: number;
    wtpOrBudgetCount: number;
    timeLossCount: number;
  };
}

export function evaluateEvidenceQuality(
  sources: EvidenceSourceSummary[],
  options: { finalScore: number; validationStatus?: string | null },
): EvidenceQualityResult;
```

**Initial rule set:**
- `validationStatus === 'fallback_template'` → `needs_more_evidence`, `adjustedMaxScore = 0`, reason `fallback_template`.
- Independent sources = unique `content_hash` if present, otherwise unique normalized title+text prefix.
- `< 3` independent sources → `needs_more_evidence`, max score `7`.
- Any self-promo / launch-brag language → count as `promo`; if promo dominates, max score `6`.
- No direct pain and no WTP/time-loss → `needs_more_evidence`, max score `7`.

**Test cases:**
- Three independent direct-pain sources → `review_eligible`.
- Three copies of the same Reddit post → `needs_more_evidence`, reason `duplicate_sources`.
- `fallback_template` → not eligible.
- “I built/launched my SaaS” post → promo reason and capped score.

**Verification:**
```bash
npx vitest run src/idea-maze/scripts/lib/evidence-quality.test.ts
```
Expected: all tests pass.

---

### Task 3: Integrate evidence gate into `process-opportunities.ts`

**Objective:** Stop launching research for opportunities that should not reach human review.

**Files:**
- Modify: `src/idea-maze/scripts/process-opportunities.ts`
- Test: create or extend `src/idea-maze/scripts/process-opportunities.test.ts` if existing integration coverage is practical; otherwise cover pure helper extraction.

**Implementation shape:**
1. Extend the candidate query or add a per-opportunity source query:
   ```sql
   SELECT si.id, si.source, si.title, si.text, si.canonical_url,
          si.channel_or_label, si.content_hash, si.metadata_json
   FROM source_items si
   JOIN opportunity_sources os ON os.source_item_id = si.id
   WHERE os.opportunity_id = ?
   ORDER BY json_extract(si.metadata_json, '$.harvest_score') DESC, si.timestamp_utc DESC
   ```
2. Before `classifyOpportunityScore(opp.final_score)`, call `evaluateEvidenceQuality`.
3. Use `Math.min(opp.final_score, quality.adjustedMaxScore)` for policy classification.
4. If disposition is not `review_eligible`, call `setOpportunityLifecycle(..., 'archived', { status: 'archived', payload: { archive_reason: 'evidence_quality_gate', evidence_quality: quality }})` and skip `researchOpportunity`.
5. Track summary counters: `quality_gate_archived`, `needs_more_evidence`, `duplicate_sources`, `promo_filtered`.

**Verification:**
```bash
npm run typecheck
npx vitest run src/idea-maze/scripts/lib/evidence-quality.test.ts src/idea-maze/scripts/lib/opportunity-policy.test.ts
```
Expected: pass.

---

## Phase 2: Quarantine fallback-template drafts

### Task 4: Change `researchOpportunity` fallback behavior

**Objective:** Prevent LLM failures/invalid drafts from entering the human review queue.

**Files:**
- Modify: `src/idea-maze/scripts/lib/research.ts`
- Modify: `src/idea-maze/scripts/lib/research.test.ts`

**Current behavior:** fallback template is saved as `runs.status = 'review_gate'` and opportunity lifecycle `review_gate`.

**New behavior:**
- If `promptMetadata.validation_status === 'fallback_template'`:
  - Save `runs.status = 'draft_ready'` or a new compatible status `needs_more_evidence` if schema/status handling supports it.
  - Prefer no schema enum migration unless needed; SQLite does not enforce status values.
  - Set opportunity lifecycle to `archived` with status `archived` and archive reason `fallback_template_research_draft`, or to a newly introduced lifecycle `needs_more_evidence` only if `OpportunityLifecycleStage` already permits/gets updated safely.
  - Record `research.quarantined` event with validation errors.
  - Return a result status that callers can handle: extend `ResearchOpportunityResult.status` to `'review_gate' | 'needs_more_evidence'`.

**Tests:**
- Update existing fallback test currently named “keeps fallback template drafts at the review gate without publishing”. It should assert fallback is quarantined, not review-gated.
- Ensure valid LLM draft still reaches `review_gate`.

**Verification:**
```bash
npx vitest run src/idea-maze/scripts/lib/research.test.ts
npm run typecheck
```
Expected: pass.

---

### Task 5: Update `process-opportunities.ts` caller for quarantined research

**Objective:** Avoid throwing when `researchOpportunity` intentionally returns `needs_more_evidence`.

**Files:**
- Modify: `src/idea-maze/scripts/process-opportunities.ts`

**Implementation:**
Replace:
```ts
if (result.status !== 'review_gate') {
  throw new Error(`Expected review gate draft for ${opp.slug}.`);
}
summary.review_gate_new++;
```
with:
```ts
if (result.status === 'review_gate') {
  summary.review_gate_new++;
} else {
  summary.needs_more_evidence++;
}
```

**Verification:**
```bash
npm run typecheck
npx vitest run src/idea-maze/scripts/lib/research.test.ts
```
Expected: pass.

---

## Phase 3: Add rejected-duplicate gate

### Task 6: Add duplicate/rejected-cluster detector

**Objective:** Prevent near-duplicates of rejected opportunities from re-entering the queue.

**Files:**
- Create: `src/idea-maze/scripts/lib/duplicate-opportunities.ts`
- Create: `src/idea-maze/scripts/lib/duplicate-opportunities.test.ts`

**Approach:** deterministic first, embedding-free.
- Normalize title, slug, cluster_key, thesis into token sets.
- Ignore stop words using existing or extracted stop-word helper from `refresh-opportunities.ts` if practical.
- Compute Jaccard similarity against opportunities where `lifecycle_stage = 'rejected'` or latest approval is `rejected`.
- Also compare source overlap via `opportunity_sources`; if candidate shares ≥1 source item with a rejected opportunity, treat as strong duplicate.

**API:**
```ts
export interface DuplicateGateResult {
  duplicate: boolean;
  matchedOpportunityId?: number;
  matchedSlug?: string;
  reasons: string[];
  similarity: number;
  sharedSourceIds: number[];
}

export function findRejectedDuplicate(
  db: Database.Database,
  candidate: { id: number; slug: string; title: string; thesis: string; cluster_key: string },
): DuplicateGateResult;
```

**Thresholds:**
- `sharedSourceIds.length > 0` + title/cluster similarity > `0.25` → duplicate.
- text similarity > `0.55` → duplicate.
- same normalized slug bigram family → duplicate.

**Tests:**
- Same source item as rejected opportunity → duplicate.
- Similar title/thesis but no shared source → duplicate when similarity high.
- Different domain with generic shared words → not duplicate.

**Verification:**
```bash
npx vitest run src/idea-maze/scripts/lib/duplicate-opportunities.test.ts
```
Expected: pass.

---

### Task 7: Integrate duplicate gate into refresh/process

**Objective:** Archive duplicates as early as possible.

**Files:**
- Modify: `src/idea-maze/scripts/refresh-opportunities.ts`
- Modify: `src/idea-maze/scripts/process-opportunities.ts` if duplicate check is easier there after sources are linked.

**Implementation preference:**
- In `refresh-opportunities.ts`, run duplicate check after `opportunity_sources` are linked and before lifecycle is set to `scored`/`active`.
- If duplicate:
  - set lifecycle `rejected` or `archived`? Prefer `archived` with `archive_reason = duplicate_rejected_opportunity` unless we want it to count as human rejection. Do not add approval row automatically.
  - status `archived`.
  - metadata includes matched rejected slug/id, similarity, shared source ids.
  - run event `opportunity.duplicate_archived`.

**Verification:**
```bash
npm run typecheck
npx vitest run src/idea-maze/scripts/lib/duplicate-opportunities.test.ts src/idea-maze/scripts/refresh-opportunities.test.ts
```
Expected: pass.

---

## Phase 4: Capture rejection reasons in human review

### Task 8: Extend human review apply path to support reason labels

**Objective:** Make taste learning more useful than generic `ignored`.

**Files:**
- Add reusable script if none exists: `src/idea-maze/scripts/apply-human-review.ts`
- Or add library: `src/idea-maze/scripts/lib/human-review.ts`
- Add tests: `src/idea-maze/scripts/lib/human-review.test.ts`

**Reason labels:**
```ts
export type RejectionReason =
  | 'duplicate'
  | 'weak_wtp'
  | 'source_contamination'
  | 'crowded_no_wedge'
  | 'generic_ai_wrapper'
  | 'consumer_retention_risk'
  | 'fallback_or_incoherent'
  | 'not_founder_fit';
```

**Implementation:**
- Store labels in `approvals.notes` as JSON-compatible text or in `runs.metadata_json.human_review`.
- Prefer `runs.metadata_json.human_review = { decision, reasons, notes, decided_by: 'kostya' }` to avoid schema migration.
- Add reason labels as `feedback_features` entries with `feature_type = 'rejection_reason'` so `taste_profile` can learn them.

**Verification:**
```bash
npx vitest run src/idea-maze/scripts/lib/human-review.test.ts
npm run typecheck
```
Expected: pass.

---

### Task 9: Update the Hermes skill/reference for review decisions

**Objective:** Ensure future manual batches use reason labels when practical.

**Files:**
- Modify Hermes skill reference, if allowed for current profile: `~/.hermes/skills/idea-maze/references/human-review-draft-decisions.md`
- Or create repo doc: `docs/idea-maze/human-review-decisions.md`

**Content:**
- Document shorthand: `reject all: duplicate, weak_wtp`.
- Document default reason mapping when Kostya says only `reject all`: use assistant’s per-run rationale from immediately preceding batch.
- Keep batch ID resolution rule: apply to the immediately preceding reviewed batch, not fresh query.

**Verification:** read back the file and confirm commands/examples are correct.

---

## Phase 5: Recalibrate score policy

### Task 10: Replace bucket-only policy with quality-aware policy

**Objective:** Make `9+` insufficient by itself.

**Files:**
- Modify: `src/idea-maze/scripts/lib/opportunity-policy.ts`
- Modify: `src/idea-maze/scripts/lib/opportunity-policy.test.ts`

**New API:**
```ts
export interface OpportunityPolicyInput {
  finalScore: number;
  evidenceQuality?: EvidenceQualityResult;
}

export function classifyOpportunityForAutomation(input: OpportunityPolicyInput): OpportunityPolicy;
```

**Compatibility:** Keep `classifyOpportunityScore(score)` as a wrapper for existing tests/callers until migration complete.

**Policy:**
- `evidenceQuality.disposition !== 'review_eligible'` → `ignore` or new disposition `needs_more_evidence`.
- Effective score = `Math.min(finalScore, evidenceQuality.adjustedMaxScore)`.
- Only effective bucket ≥ 9 gets `publish_artifact`/review-gate.

**Verification:**
```bash
npx vitest run src/idea-maze/scripts/lib/opportunity-policy.test.ts src/idea-maze/scripts/lib/evidence-quality.test.ts
npm run typecheck
```
Expected: pass.

---

## Phase 6: Add diagnostics so we can prove it worked

### Task 11: Add quality-gate reporting to status or a new inspect command

**Objective:** Make future pipeline health visible.

**Files:**
- Modify: `src/idea-maze/scripts/pipeline-status.ts` or create `src/idea-maze/scripts/inspect-review-gate-quality.ts`
- Add package script if new command: `package.json`

**Metrics:**
- pending review-gate count
- fallback-template count
- average final score of pending/rejected recent runs
- count by archive reason: `evidence_quality_gate`, `duplicate_rejected_opportunity`, `fallback_template_research_draft`
- top rejection reasons from `human_review.reasons` / feedback features

**Verification:**
```bash
npm run typecheck
npm run idea:status -- --json
# if new script:
npx tsx src/idea-maze/scripts/inspect-review-gate-quality.ts --json
```
Expected: JSON includes quality gate counters.

---

## Phase 7: End-to-end verification

### Task 12: Run focused and full verification

**Objective:** Ensure the pipeline still runs and quality gates do not break normal flows.

**Commands:**
```bash
npm run typecheck
npm test
```

**Optional dry-run check against production DB (read-only first):**
Create a read-only diagnostic script or command that reports how many currently active opportunities would be filtered by the new gate. Do not mutate `/workspace/idea-maze/data/lab.db` until reviewed.

**Expected output:**
- Tests pass.
- Diagnostic report shows fewer review-gate candidates, with reason counts.

---

## Suggested Implementation Order

1. Evidence quality module + tests.
2. Process-opportunities quality gate.
3. Fallback-template quarantine.
4. Duplicate/rejected detector.
5. Rejection reason labels.
6. Diagnostics/status reporting.

This order gives immediate noise reduction before touching broader taste-learning behavior.

---

## Rollback Strategy

- All new gates should be deterministic and metadata-backed.
- Add environment override for first rollout:
  ```bash
  IDEA_MAZE_DISABLE_QUALITY_GATE=1
  ```
  so the pipeline can bypass quality filtering if it is too aggressive.
- Keep archived reasons in metadata so accidental filters can be audited and manually restored.

---

## Open Decisions for Kostya

1. Should `fallback_template` become `archived` or `needs_more_evidence`? My default: `archived` with reason `fallback_template_research_draft` because it should not consume review attention.
2. Should duplicate-of-rejected count as `rejected` lifecycle or only `archived`? My default: `archived` without approval row, to distinguish automated filter from human decision.
3. Do we want a lightweight CLI for human review decisions now, or keep temporary scripts and only add reason-label support later? My default: add `apply-human-review.ts` because we just used this workflow repeatedly.
