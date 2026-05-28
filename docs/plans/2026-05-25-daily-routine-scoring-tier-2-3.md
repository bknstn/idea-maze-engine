# Daily Routine Reddit Scoring Tier 2/3 Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Improve Idea Maze Reddit harvest scoring for health/fitness, learning/memory, personal productivity, and travel so daily-routine pains surface with higher precision and fewer business/HTML false positives.

**Architecture:** Keep scoring deterministic and local to `src/idea-maze/scripts/lib/scoring.ts` first. Tier 2 adds topic-aware weighting based on subreddit/category metadata. Tier 3 validates against real harvested Reddit data, tunes weights/terms, and adds an inspection/reporting loop before any further pipeline automation.

**Tech Stack:** TypeScript, Vitest, SQLite runtime DB at `/workspace/idea-maze/data/lab.db`, npm scripts in `package.json`.

---

## Current State

Already done:

- Runtime subreddit set shifted toward daily-routine domains.
- Tier 1 scoring added signals:
  - `routine-friction`
  - `tracking-planning`
  - `health-fitness`
  - `learning-memory`
  - `productivity-friction`
  - `travel-logistics`
- HTML/URL/entity normalization added to scoring haystack.
- Broad false-positive terms were reduced.
- Latest pushed commits:
  - `d254d2f` — `Tune Reddit scoring for daily routines`
  - `05b112a` — `Reduce daily routine scoring false positives`

Known issue after real-data validation:

- Business posts can still outrank daily-routine posts because legacy business signals (`existing-spend`, `workflow-context`, `manual-work`, source patterns) are stronger and domain-agnostic.
- Daily-routine terms are global; they should become stronger inside matching subreddits and weaker outside them.
- Some feed posts are megathreads/promotional/showcase posts and should be downweighted unless concrete pain is present.

---

## Tier 2: Topic-Aware Deterministic Scoring

### Task 1: Add subreddit topic classification tests

**Objective:** Classify Reddit source items into coarse topic groups using `metadata.subreddit` / `channel_or_label`-style values.

**Files:**

- Modify: `src/idea-maze/scripts/lib/scoring.ts`
- Test: `src/idea-maze/scripts/lib/scoring.test.ts`

**Step 1: Write failing tests**

Add tests that assert examples are classified/weighted correctly through public behavior, not private exports:

- `r/bodyweightfitness` + plateau/recovery text emits `health-fitness` and scores above a similar business post with only broad wording.
- `r/Anki` + retention/review backlog emits `learning-memory` without needing business spend terms.
- `r/onebag` + packing/visa/itinerary emits `travel-logistics`.
- `r/SaaS` with `review`, `form`, `program`, `travel`, `running` in generic business text does **not** emit daily-routine signals.

**Step 2: Run tests to verify failure**

```bash
npx vitest run src/idea-maze/scripts/lib/scoring.test.ts
```

Expected: new tests fail because scoring has no topic-group weighting yet.

**Step 3: Implement minimal topic classification**

In `scoring.ts`, add constants:

```ts
const HEALTH_SUBREDDITS = new Set(['r/bodyweightfitness', 'r/beginnerfitness', 'r/running', 'r/ouraring', 'r/garmin', 'r/biohackers']);
const LEARNING_SUBREDDITS = new Set(['r/getstudying', 'r/anki', 'r/memory', 'r/mnemonics', 'r/languagelearning']);
const PRODUCTIVITY_SUBREDDITS = new Set(['r/productivity', 'r/selfimprovement', 'r/decidingtobebetter']);
const TRAVEL_SUBREDDITS = new Set(['r/onebag', 'r/solotravel', 'r/digitalnomad', 'r/shoestring']);
```

Normalize subreddit value to lowercase before lookup.

**Step 4: Run focused tests**

```bash
npx vitest run src/idea-maze/scripts/lib/scoring.test.ts
```

Expected: tests pass.

---

### Task 2: Add topic-aware weights, not new schema

**Objective:** Boost topic-relevant signals only in matching subreddit groups; avoid schema changes.

**Files:**

- Modify: `src/idea-maze/scripts/lib/scoring.ts`
- Test: `src/idea-maze/scripts/lib/scoring.test.ts`

**Implementation rule:** Keep existing metadata shape. Continue writing to existing `harvest_signals`, `source_patterns`, and `harvest_breakdown`.

**Suggested scoring behavior:**

- Health subreddits:
  - `health-fitness`: higher per-match, max around `0.18`
  - `routine-friction`: modest boost when co-occurs with health terms
- Learning subreddits:
  - `learning-memory`: higher per-match, max around `0.18`
  - `tracking-planning`: modest boost for review/backlog/schedule terms
- Productivity subreddits:
  - `productivity-friction`: higher per-match, max around `0.18`
  - `routine-friction`: higher per-match, max around `0.18`
- Travel subreddits:
  - `travel-logistics`: higher per-match, max around `0.18`
  - `tracking-planning`: modest boost for itinerary/booking/checklist/budget
- Outside matching groups:
  - keep Tier 1 weights or reduce broad category weights slightly.

**Step 1: Add failing tests**

Test same text in matching vs non-matching subreddits:

```ts
const health = scoreRedditPost('Plateau...', 'recovery soreness deload...', 'bodyweightfitness');
const business = scoreRedditPost('Plateau...', 'recovery soreness deload...', 'SaaS');
expect(health.score).toBeGreaterThan(business.score);
```

**Step 2: Implement helper**

Add helper shape similar to:

```ts
function topicWeight(topicMatches: boolean, basePerMatch: number, boostedPerMatch: number): number {
  return topicMatches ? boostedPerMatch : basePerMatch;
}
```

Or just use inline constants for clarity.

**Step 3: Verify**

```bash
npx vitest run src/idea-maze/scripts/lib/scoring.test.ts
npm run typecheck
```

Expected: pass.

---

### Task 3: Add anti-noise pattern penalties for daily-routine feeds

**Objective:** Downweight megathreads, broad motivation, pure showcase/success posts, and promotional/affiliate-ish content unless concrete friction exists.

**Files:**

- Modify: `src/idea-maze/scripts/lib/scoring.ts`
- Test: `src/idea-maze/scripts/lib/scoring.test.ts`

**Candidate pattern signals:**

- `megathread-noise`: `megathread`, `weekly thread`, `daily thread`, `bag finder megathread`
- `motivation-only`: `you can do it`, `believe in yourself`, `success story`, `I made it`, `thank you community`
- `showcase-only`: `my setup`, `rate my`, `review my fit`, `what would you optimize` may be useful but should not outrank pain posts unless it includes `stuck/problem/need/help/can't`.

**Important:** Do not over-penalize true help requests. A post titled `Need help traveling to Cincinnati` should remain eligible.

**Step 1: Add tests**

- Bag finder megathread should score below `0.55` unless it includes concrete user pain.
- Generic success/motivation post should stay below `0.55`.
- Need-help travel post with `visa/safety/itinerary/budget` should stay above `0.55`.

**Step 2: Implement patterns**

Extend `PATTERN_RULES` with negative patterns or add explicit penalty after signals are computed.

Suggested weights:

- `megathread-noise`: `-0.16`
- `motivation-only`: `-0.12`
- `showcase-only`: `-0.08`

Only apply full penalty if no `complaint-language`, no `routine-friction`, and no `tracking-planning`.

**Step 3: Verify**

```bash
npx vitest run src/idea-maze/scripts/lib/scoring.test.ts
```

---

### Task 4: Commit Tier 2 scoring changes

**Objective:** Keep Tier 2 as one small reviewable commit.

**Commands:**

```bash
git status --short
git diff -- src/idea-maze/scripts/lib/scoring.ts src/idea-maze/scripts/lib/scoring.test.ts
npm run typecheck
npm test
git add src/idea-maze/scripts/lib/scoring.ts src/idea-maze/scripts/lib/scoring.test.ts
git commit -m "Tune Reddit scoring by topic" -m "Co-authored-by: Buddy <dobby.aibuddy@gmail.com>"
git push origin main
```

**Expected:** All tests pass; pushed to `main` only if Kostya has authorized push for that session.

---

## Tier 3: Real-Data Validation and Calibration

### Task 5: Add a read-only harvest inspection script

**Objective:** Make tuning evidence-driven instead of ad hoc SQL snippets.

**Files:**

- Create: `src/idea-maze/scripts/inspect-reddit-harvest.ts`
- Modify: `package.json`
- Test: optional unit test if script logic is factored into a helper.

**CLI behavior:**

```bash
IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:inspect:reddit -- --since 2026-05-25T20:06:22Z --limit 30 --json
```

Output JSON fields:

- `summary.total_items`
- `summary.daily_items`
- `summary.with_insights`
- `summary.without_insights`
- `signal_counts`
- `top_subreddits`
- `top_items`
  - `id`
  - `subreddit`
  - `title`
  - `score`
  - `signals`
  - `patterns`
  - `insight_count`
  - `insight_types`
  - `topic_group`

**Implementation notes:**

- Use `getDb()`, `initSchema(db)` for consistency.
- Read-only behavior only. No DB writes.
- Default `--since` to latest `reddit_last_harvest` minus a safe window only if easy; otherwise require explicit `--since`.
- Add package script:

```json
"idea:inspect:reddit": "tsx src/idea-maze/scripts/inspect-reddit-harvest.ts"
```

**Verification:**

```bash
IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:inspect:reddit -- --since <timestamp> --json --limit 10
```

Expected: JSON parses and includes top daily-routine items.

---

### Task 6: Build a small labeled calibration set

**Objective:** Create a durable sample of Reddit items for scoring regression.

**Files:**

- Create: `src/idea-maze/scripts/lib/scoring-fixtures.test.ts` OR extend `scoring.test.ts`
- Optional fixture: `src/idea-maze/scripts/lib/fixtures/reddit-scoring-cases.ts`

**Labels:**

Use 20–40 examples from real harvest, grouped as:

- `strong_daily_pain`
- `weak_daily_noise`
- `strong_business_pain`
- `business_false_positive_daily_terms`
- `megathread_noise`
- `promotional_showcase`

Each fixture should include:

```ts
{
  title: '...',
  text: '...',
  subreddit: 'r/Anki',
  expectedSignals: ['learning-memory'],
  minScore: 0.55,
  maxScore?: 0.85,
}
```

**Acceptance criteria:**

- Strong daily pain scores `>= 0.55`.
- Weak daily noise scores `< 0.55`.
- Business false positives do not emit unrelated daily-topic signals.
- Travel/help/logistics posts stay eligible.

---

### Task 7: Run calibration loop from real data

**Objective:** Tune weights using latest Reddit harvest and extracted insights.

**Steps:**

1. Run ingest:

```bash
set -a; . /home/hermes/.hermes/.env; set +a; IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:ingest:reddit
```

2. Run extraction enough times to cover top daily-routine items:

```bash
set -a; . /home/hermes/.hermes/.env; set +a; IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:extract
```

3. Inspect:

```bash
IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:inspect:reddit -- --since <baseline> --json --limit 50
```

4. Manually review top 30:

- Keep: concrete pain/workaround/request.
- Maybe: vague but recurring workflow.
- Drop: generic motivation, megathread, pure content/update, pure showcase, medical unsafe territory.

5. Adjust weights/terms minimally.

6. Re-run tests and inspection.

---

### Task 8: Decide whether to rebalance business vs daily topics

**Objective:** Avoid business sources permanently dominating top harvest.

**Options:**

1. **No rebalance:** Let raw score decide. Lowest complexity, but business likely dominates.
2. **Topic quota in processing:** Keep scoring as signal quality, but downstream processing samples top N per topic group. Better diversity.
3. **Topic prior:** Add small daily-routine topic boost (`+0.03` to `+0.06`) when concrete pain exists. Risk: overfits consumer topics.

**Recommended:** Option 2 later, not now. Add a processing-stage topic quota only if daily-routine candidates are good but underrepresented after Tier 2.

Potential files for later:

- `src/idea-maze/scripts/extract-insights.ts`
- `src/idea-maze/scripts/process-opportunities.ts`
- `src/idea-maze/scripts/lib/queries.ts`

Do not implement until scoring inspection proves it is necessary.

---

## Suggested Next Session Flow

1. Load skills: `idea-maze`, `repo-coding`, `test-driven-development`.
2. Start from Tier 2 Task 1.
3. Work TDD-first.
4. Keep one commit for Tier 2 scoring.
5. Run one ingest/extract/inspect cycle.
6. If top items still show clear false positives, do Task 3 before moving to Tier 3.
7. Save any newly discovered scoring workflow as a skill or patch `idea-maze` skill notes.

---

## Success Criteria

Tier 2 is successful when:

- Daily-routine posts with concrete friction score `>= 0.55`.
- Generic motivational/megathread/showcase posts score `< 0.55` unless they include concrete pain.
- Business posts no longer emit unrelated `health-fitness`, `learning-memory`, or `travel-logistics` from broad terms/HTML noise.
- Top daily-routine harvest contains real product-discovery material, not only community chatter.

Tier 3 is successful when:

- We have a repeatable inspection command.
- We have a durable labeled fixture set from real Reddit data.
- Weight/term changes are driven by fixture failures and top-item review, not guesses.
- We know whether downstream topic quotas are needed.
