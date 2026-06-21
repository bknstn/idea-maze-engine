# Explore Command/Stage Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a first-class `idea:explore` command/stage that turns approved active opportunities into deeper exploration briefs: ICP, evidence expansion, competitor map, interview script, smoke-test plan, kill criteria, and recommended next action.

**Architecture:** Keep `approved` as a sticky human-review lifecycle state; exploration should not publish artifacts or overwrite approval/rejection state. Add a first-class exploration module that supports two modes: (1) default engine-owned generation through `lib/llm.ts` using a stage-specific exploration model, and (2) Hermes/manual handoff mode where Idea Maze prepares context and finalizes externally generated JSON. This keeps the engine autonomous for cron/batch usage while allowing Hermes to use the current active model for deeper founder-track reasoning when requested. Use existing search enrichment only as contextual research, not as independent buyer-pain evidence.

**Tech Stack:** TypeScript, Node/tsx, better-sqlite3, Vitest, existing Idea Maze CLI conventions, existing `lib/llm.ts` provider routing extended with `exploration` model policy, JSON handoff between Idea Maze and Hermes for override mode, existing `lib/search.ts` Tavily integration for optional context only.

---

## Acceptance Criteria

- `npm run idea:explore -- --id <slug> --json` runs the default engine-owned exploration flow for opportunities with `lifecycle_stage='approved'` and `status='active'`.
- The command refuses non-approved/non-active opportunities unless `--force` is passed.
- Default exploration uses `lib/llm.ts`, not direct provider calls, and records the selected exploration model/provider in run metadata.
- `lib/llm.ts` exposes an exploration task/model selector (`getExplorationModel()` and `generateExplorationJson()` or equivalent) with env overrides.
- Exploration does **not** call `publishResearchArtifact`, does **not** insert into `artifacts`, and does **not** change `approved` / `rejected` lifecycle states.
- A successful default engine run creates:
  - a `runs` row with `run_type='explore'`, `status='completed'`, target opportunity id, and structured metadata;
  - a markdown file under `/workspace/idea-maze/data/explorations/YYYY/MM/DD/<slug>.md`;
  - an `exploration_artifacts` row pointing to the file.
- Hermes/manual override mode is also supported:
  - `npm run idea:explore -- --id <slug> --prepare-only --json` creates a run with `status='awaiting_external_brief'` and returns prompt/context/schema.
  - `npm run idea:explore -- --run-id <id> --brief-file <path> --json` validates and finalizes the externally generated brief.
- If engine LLM generation fails or external validation fails, the command returns `needs_manual_exploration` with validation/errors and warning events; it should not fabricate deep research.
- Exploration output includes these required sections: ICP, direct evidence summary, competitor map, workflow/wedge, interview script, smoke test, pricing hypothesis, kill criteria, open questions, next action.
- `npm run typecheck` and relevant Vitest suites pass.

---

## Non-Goals

- Do not run exploration automatically inside `idea:run` yet.
- Do not export exploration briefs to GitHub/artifact repo yet.
- Do not treat Tavily/search refs as independent buyer-pain evidence.
- Do not add a new opportunity lifecycle stage unless explicitly required later; approved/rejected sticky states must remain stable.
- Do not build outreach automation, landing pages, or interview scheduling in this change.
- Do not make existing `extract` / `research` / `process` stages Hermes-dependent; they remain autonomous engine stages.

---

## Phase 0: Branch and baseline

### Task 1: Create implementation branch

**Objective:** Isolate all changes.

**Files:** none

**Steps:**
1. Run:
   ```bash
   git status --short --branch
   git checkout -b agent/explore-command-stage
   ```
2. Expected: branch created from clean `main`.

**Verification:**
```bash
git status --short --branch
```
Expected: `## agent/explore-command-stage` and no unrelated changes.

---

### Task 2: Run baseline verification

**Objective:** Confirm current repo state before changing behavior.

**Files:** none

**Steps:**
1. Run:
   ```bash
   npm run typecheck
   npm test
   ```
2. Expected: both pass before implementation.

**Commit:** none.

---

## Phase 1: Define exploration data contract

### Task 3: Add exploration types and validator tests first

**Objective:** Specify the JSON shape both `lib/llm.ts` engine generation and Hermes/manual override must return.

**Files:**
- Modify: `src/idea-maze/scripts/lib/validation.ts`
- Modify: `src/idea-maze/scripts/lib/validation.test.ts`

**Step 1: Write failing tests**

Append tests to `validation.test.ts` for a new `validateExplorationBrief()` function:

```ts
it('validates complete exploration briefs', () => {
  const result = validateExplorationBrief({
    thesis: 'Managers lose delegated tasks across voice, calls, and chat.',
    icp: {
      buyer: 'Owner-manager of a 5-20 person field-service team',
      user: 'Manager delegating work on the move',
      trigger: 'Tasks get lost after phone calls or site visits',
      current_workaround: 'WhatsApp, notes app, memory, spreadsheets',
      budget_owner: 'Owner-manager',
    },
    evidence_summary: [
      {
        source_type: 'reddit',
        quote_or_summary: 'A manager asks for a voice-first delegation system.',
        interpretation: 'Direct workflow pain, not generic voice interest.',
        evidence_role: 'buyer_pain',
      },
    ],
    competitor_map: [
      {
        name: 'Todoist',
        category: 'task manager',
        positioning: 'General-purpose task capture',
        weakness: 'Not voice-first delegated-team follow-up',
      },
    ],
    workflow_wedge: {
      narrow_workflow: 'Speak task → assign person → confirm → follow up',
      must_have_features: ['voice capture', 'assignee extraction', 'confirmation'],
      explicit_non_goals: ['full project management'],
    },
    interview_script: ['Tell me about the last delegated task that got lost.'],
    smoke_test: {
      audience: 'Managers of 5-20 person teams',
      offer: 'Voice-first delegation inbox',
      channel: 'Reddit/manual outreach',
      success_metric: '5 calls booked from 50 outreaches',
    },
    pricing_hypothesis: '$19-$49/month per manager',
    kill_criteria: ['Fewer than 3/10 buyers report lost delegated tasks weekly'],
    open_questions: ['Which communication channel matters first?'],
    next_action: 'Run 10 buyer interviews before building.',
  });

  expect(result.errors).toEqual([]);
  expect(result.value?.icp.buyer).toContain('Owner-manager');
});

it('rejects exploration briefs missing kill criteria', () => {
  const result = validateExplorationBrief({ thesis: 'Too thin' });
  expect(result.value).toBeNull();
  expect(result.errors).toContain('brief.kill_criteria must be an array');
});
```

**Step 2: Run test to verify failure**

```bash
npx vitest run src/idea-maze/scripts/lib/validation.test.ts --runInBand
```
Expected: FAIL because `validateExplorationBrief` does not exist.

**Step 3: Implement minimal validator**

Add exported interfaces to `validation.ts`:

```ts
export interface ValidatedExplorationBrief {
  thesis: string;
  icp: {
    buyer: string;
    user: string;
    trigger: string;
    current_workaround: string;
    budget_owner: string;
  };
  evidence_summary: Array<{
    source_type: string;
    quote_or_summary: string;
    interpretation: string;
    evidence_role: string;
  }>;
  competitor_map: Array<{
    name: string;
    category: string;
    positioning: string;
    weakness: string;
  }>;
  workflow_wedge: {
    narrow_workflow: string;
    must_have_features: string[];
    explicit_non_goals: string[];
  };
  interview_script: string[];
  smoke_test: {
    audience: string;
    offer: string;
    channel: string;
    success_metric: string;
  };
  pricing_hypothesis: string;
  kill_criteria: string[];
  open_questions: string[];
  next_action: string;
}
```

Implement `validateExplorationBrief(input: unknown): ValidationResult<ValidatedExplorationBrief>` using existing helpers: `validateObject`, `validateString`, and `validateStringArray`. Add small local helper functions for object arrays.

**Step 4: Verify pass**

```bash
npx vitest run src/idea-maze/scripts/lib/validation.test.ts --runInBand
```
Expected: PASS.

**Commit:**
```bash
git add src/idea-maze/scripts/lib/validation.ts src/idea-maze/scripts/lib/validation.test.ts
git commit -m "test: define exploration brief validation contract"
```

---

### Task 4: Add exploration prompt contract tests first

**Objective:** Define the prompt API without touching orchestration yet.

**Files:**
- Modify: `src/idea-maze/scripts/lib/prompts.ts`
- Create: `src/idea-maze/scripts/lib/prompts.test.ts`

**Step 1: Write failing tests**

Create `prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  EXPLORATION_PROMPT_NAME,
  EXPLORATION_PROMPT_VERSION,
  buildExplorationUserPrompt,
} from './prompts.ts';

describe('exploration prompt', () => {
  it('includes approved opportunity context and required JSON fields', () => {
    const prompt = buildExplorationUserPrompt({
      slug: 'voice-looking',
      title: 'Voice Looking',
      thesis: 'Managers lose delegated tasks.',
      approved_research_draft: 'Voice-first delegation draft.',
      source_evidence: ['reddit: direct buyer asks for voice delegation'],
      contextual_research: ['Todoist is broad task management'],
      search_synthesis: ['Competitors are broad PM tools'],
    });

    expect(EXPLORATION_PROMPT_NAME).toBe('idea-maze-exploration');
    expect(EXPLORATION_PROMPT_VERSION).toMatch(/^2026-/);
    expect(prompt).toContain('voice-looking');
    expect(prompt).toContain('approved_research_draft');
    expect(prompt).toContain('competitor_map');
    expect(prompt).toContain('kill_criteria');
    expect(prompt).toContain('Do not count web search as independent buyer-pain evidence');
  });
});
```

**Step 2: Run test to verify failure**

```bash
npx vitest run src/idea-maze/scripts/lib/prompts.test.ts --runInBand
```
Expected: FAIL because exports do not exist.

**Step 3: Implement prompt exports**

Add to `prompts.ts`:

```ts
export const EXPLORATION_PROMPT_NAME = 'idea-maze-exploration';
export const EXPLORATION_PROMPT_VERSION = '2026-06-21.1';

export const EXPLORATION_SYSTEM_PROMPT = `You are a founder-track product researcher creating a deep exploration brief for an already approved opportunity.

Rules:
- Approved means worth exploring, not worth building yet.
- Sharpen buyer, trigger, current workaround, WTP, distribution, and kill criteria.
- Use direct buyer/source evidence for pain. Do not count web search as independent buyer-pain evidence.
- Web search is only competitor/context research.
- Prefer narrow self-serve wedges a solo founder can test quickly.
- Be explicit when evidence is thin.`;

export function buildExplorationUserPrompt(input: {
  slug: string;
  title: string;
  thesis: string;
  approved_research_draft: string;
  source_evidence: string[];
  contextual_research: string[];
  search_synthesis?: string[];
}): string {
  const fmtList = (items: string[]) => items.length ? items.map((s) => `- ${s}`).join('\n') : '- None';
  return `Explore this approved opportunity before build/no-build decision.

Opportunity: ${input.slug}
Title: ${input.title}
Current Thesis: ${input.thesis}

## Approved Research Draft
approved_research_draft:
${input.approved_research_draft || 'None'}

## Direct Source Evidence
${fmtList(input.source_evidence)}

## Contextual Research / Competitors
${fmtList(input.contextual_research)}

## Search Synthesis
${fmtList(input.search_synthesis ?? [])}

Do not count web search as independent buyer-pain evidence.

Return JSON with this exact structure:
{
  "thesis": "sharpened thesis",
  "icp": {
    "buyer": "specific buyer",
    "user": "specific user",
    "trigger": "when pain appears",
    "current_workaround": "what they do now",
    "budget_owner": "who pays"
  },
  "evidence_summary": [
    {
      "source_type": "reddit|gmail|telegram|search|manual",
      "quote_or_summary": "evidence",
      "interpretation": "what it proves or does not prove",
      "evidence_role": "buyer_pain|workflow|wtp|competitor_context|risk"
    }
  ],
  "competitor_map": [
    {
      "name": "competitor/tool/current workaround",
      "category": "category",
      "positioning": "what it does",
      "weakness": "why wedge may still exist"
    }
  ],
  "workflow_wedge": {
    "narrow_workflow": "one workflow to own",
    "must_have_features": ["feature"],
    "explicit_non_goals": ["non-goal"]
  },
  "interview_script": ["question"],
  "smoke_test": {
    "audience": "who to target",
    "offer": "landing/outreach promise",
    "channel": "first channel",
    "success_metric": "numeric pass threshold"
  },
  "pricing_hypothesis": "price and packaging",
  "kill_criteria": ["numeric or concrete kill criterion"],
  "open_questions": ["question"],
  "next_action": "single next action"
}`;
}
```

**Step 4: Verify pass**

```bash
npx vitest run src/idea-maze/scripts/lib/prompts.test.ts --runInBand
```
Expected: PASS.

**Commit:**
```bash
git add src/idea-maze/scripts/lib/prompts.ts src/idea-maze/scripts/lib/prompts.test.ts
git commit -m "feat: add exploration prompt contract"
```

---

## Phase 2: Extend engine LLM routing for exploration

### Task 5: Add exploration model routing tests first

**Objective:** Keep the default explore flow aligned with existing engine-owned LLM stages while allowing a smarter exploration model tier.

**Files:**
- Modify: `src/idea-maze/scripts/lib/llm.ts`
- Modify: `src/idea-maze/scripts/lib/llm.test.ts`

**Step 1: Write failing tests**

Add tests covering:

```ts
it('selects explicit OpenAI exploration model override', async () => {
  process.env.OPENAI_API_KEY = 'test';
  process.env.OPENAI_EXPLORATION_MODEL = 'gpt-5.5';
  const { getExplorationModel } = await import('./llm.ts');
  expect(getExplorationModel()).toBe('gpt-5.5');
});

it('selects explicit Anthropic exploration model override', async () => {
  process.env.ANTHROPIC_API_KEY = 'test';
  process.env.ANTHROPIC_EXPLORATION_MODEL = 'claude-opus-4-5';
  const { getExplorationModel } = await import('./llm.ts');
  expect(getExplorationModel()).toBe('claude-opus-4-5');
});
```

Also add a test that `generateExplorationJson()` calls the same provider abstraction as `generateResearchJson()` but uses exploration max-token/model settings.

**Step 2: Run test to verify failure**

```bash
npx vitest run src/idea-maze/scripts/lib/llm.test.ts --runInBand
```
Expected: FAIL because exploration model helpers do not exist.

**Step 3: Implement minimal LLM routing**

In `lib/llm.ts` add:

```ts
export const EXPLORATION_MODEL = 'claude-opus-4-5';
const OPENAI_EXPLORATION_MODEL = 'gpt-5.5';

export function getExplorationModel(): string | null {
  const provider = getConfiguredProvider();
  if (!provider) return null;
  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_EXPLORATION_MODEL ?? EXPLORATION_MODEL;
  }
  return process.env.OPENAI_EXPLORATION_MODEL ?? OPENAI_EXPLORATION_MODEL;
}

export async function generateExplorationJson<T>(
  systemPrompt: string,
  userPrompt: string,
): Promise<T> {
  return callApi<T>(EXPLORATION_MODEL, systemPrompt, userPrompt, 8192, RESEARCH_REQUEST_TIMEOUT_MS);
}
```

If `callApi()` currently maps OpenAI by anthropic model constants only, refactor the model-selection helper so `generateExplorationJson()` actually uses `getExplorationModel()` for both providers. Keep extraction/research behavior unchanged.

**Step 4: Verify pass**

```bash
npx vitest run src/idea-maze/scripts/lib/llm.test.ts --runInBand
```
Expected: PASS.

**Commit:**
```bash
git add src/idea-maze/scripts/lib/llm.ts src/idea-maze/scripts/lib/llm.test.ts
git commit -m "feat: add exploration llm routing"
```

---

## Phase 3: Add durable exploration storage

### Task 5: Add `exploration_artifacts` schema migration tests first

**Objective:** Make exploration briefs listable without overloading published `artifacts`.

**Files:**
- Modify: `src/idea-maze/scripts/lib/schema.ts`
- Modify: `src/idea-maze/scripts/lib/schema.test.ts`

**Step 1: Write failing test**

Add to `schema.test.ts`:

```ts
it('creates exploration_artifacts for deep exploration briefs', async () => {
  const { getDb } = await import('./db.ts');
  const { initSchema } = await import('./schema.ts');

  const db = getDb();
  initSchema(db);

  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='exploration_artifacts'")
    .all() as Array<{ name: string }>;
  expect(table).toHaveLength(1);

  const columns = db
    .prepare('PRAGMA table_info(exploration_artifacts)')
    .all() as Array<{ name: string }>;
  expect(columns.map((column) => column.name)).toEqual([
    'id',
    'opportunity_id',
    'run_id',
    'path',
    'brief_json',
    'created_at_utc',
  ]);
});
```

**Step 2: Run test to verify failure**

```bash
npx vitest run src/idea-maze/scripts/lib/schema.test.ts --runInBand
```
Expected: FAIL because table does not exist.

**Step 3: Implement schema**

In `initSchema()` add:

```sql
CREATE TABLE IF NOT EXISTS exploration_artifacts (
  id              INTEGER PRIMARY KEY,
  opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  run_id          INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  path            TEXT    NOT NULL,
  brief_json      TEXT    NOT NULL,
  created_at_utc  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_exploration_artifacts_opportunity_id ON exploration_artifacts(opportunity_id);
CREATE INDEX IF NOT EXISTS ix_exploration_artifacts_run_id         ON exploration_artifacts(run_id);
CREATE INDEX IF NOT EXISTS ix_exploration_artifacts_created_at_utc ON exploration_artifacts(created_at_utc);
```

Do **not** modify existing `artifacts` semantics.

**Step 4: Verify pass**

```bash
npx vitest run src/idea-maze/scripts/lib/schema.test.ts --runInBand
```
Expected: PASS.

**Commit:**
```bash
git add src/idea-maze/scripts/lib/schema.ts src/idea-maze/scripts/lib/schema.test.ts
git commit -m "feat: add exploration artifact storage"
```

---

## Phase 4: Implement pure exploration rendering and paths

### Task 6: Add exploration markdown renderer tests first

**Objective:** Ensure exploration briefs render consistently and outside published artifacts.

**Files:**
- Create: `src/idea-maze/scripts/lib/exploration.ts`
- Create: `src/idea-maze/scripts/lib/exploration.test.ts`

**Step 1: Write failing tests**

Create `exploration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { explorationRelativePath, renderExplorationMarkdown } from './exploration.ts';
import type { ValidatedExplorationBrief } from './validation.ts';

const brief: ValidatedExplorationBrief = {
  thesis: 'Managers lose delegated tasks across voice and chat.',
  icp: {
    buyer: 'Owner-manager',
    user: 'Manager',
    trigger: 'After calls or site visits',
    current_workaround: 'WhatsApp and memory',
    budget_owner: 'Owner-manager',
  },
  evidence_summary: [{
    source_type: 'reddit',
    quote_or_summary: 'Need voice-first delegation.',
    interpretation: 'Direct pain.',
    evidence_role: 'buyer_pain',
  }],
  competitor_map: [{
    name: 'Todoist',
    category: 'task manager',
    positioning: 'General tasks',
    weakness: 'No delegation confirmation workflow',
  }],
  workflow_wedge: {
    narrow_workflow: 'Speak → assign → confirm → follow up',
    must_have_features: ['voice capture'],
    explicit_non_goals: ['full PM suite'],
  },
  interview_script: ['What was the last task that got lost?'],
  smoke_test: {
    audience: '10-person team managers',
    offer: 'Voice delegation inbox',
    channel: 'manual outreach',
    success_metric: '5 calls / 50 outreaches',
  },
  pricing_hypothesis: '$29/month',
  kill_criteria: ['<3/10 report weekly pain'],
  open_questions: ['Which channel first?'],
  next_action: 'Interview 10 managers.',
};

describe('exploration rendering', () => {
  it('renders all required sections with frontmatter', () => {
    const markdown = renderExplorationMarkdown(brief, {
      runId: 42,
      opportunitySlug: 'voice-looking',
      createdAtUtc: '2026-06-21T00:00:00.000Z',
    });

    expect(markdown).toContain('run_id: 42');
    expect(markdown).toContain('opportunity_slug: voice-looking');
    expect(markdown).toContain('## ICP');
    expect(markdown).toContain('## Competitor Map');
    expect(markdown).toContain('## Kill Criteria');
    expect(markdown).toContain('Interview 10 managers.');
  });

  it('uses explorations path, not artifacts path', () => {
    const date = new Date('2026-06-21T12:00:00.000Z');
    expect(explorationRelativePath('voice-looking', date)).toBe(
      'data/explorations/2026/06/21/voice-looking.md',
    );
  });
});
```

**Step 2: Run test to verify failure**

```bash
npx vitest run src/idea-maze/scripts/lib/exploration.test.ts --runInBand
```
Expected: FAIL because module does not exist.

**Step 3: Implement minimal renderer/path helpers**

In `exploration.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ValidatedExplorationBrief } from './validation.ts';
import { DATA_DIR } from './paths.ts';

export function explorationRelativePath(slug: string, timestamp = new Date()): string {
  const y = timestamp.getUTCFullYear();
  const m = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
  const d = String(timestamp.getUTCDate()).padStart(2, '0');
  return `data/explorations/${y}/${m}/${d}/${slug}.md`;
}

export function resolveExplorationPath(relativePath: string): string {
  return resolve(DATA_DIR, '..', relativePath.replace(/^data\//, 'data/'));
}
```

Implement `renderExplorationMarkdown(brief, meta)` with frontmatter and all sections. Add `writeExplorationMarkdown(relativePath, markdown)` that creates parent dirs and writes UTF-8.

**Step 4: Verify pass**

```bash
npx vitest run src/idea-maze/scripts/lib/exploration.test.ts --runInBand
```
Expected: PASS.

**Commit:**
```bash
git add src/idea-maze/scripts/lib/exploration.ts src/idea-maze/scripts/lib/exploration.test.ts
git commit -m "feat: render exploration briefs"
```

---

## Phase 5: Implement exploration orchestration

### Task 7: Add approved-opportunity guard tests first

**Objective:** Ensure only approved active opportunities can be explored by default.

**Files:**
- Modify: `src/idea-maze/scripts/lib/exploration.ts`
- Modify: `src/idea-maze/scripts/lib/exploration.test.ts`

**Step 1: Write failing tests**

Add test setup similar to `research.test.ts`: temp `IDEA_MAZE_HOME`, `getDb()`, `initSchema()`.

Add tests:

```ts
it('refuses non-approved opportunities by default', async () => {
  const db = getDb();
  initSchema(db);
  insertOpportunity(db, { slug: 'raw-idea', lifecycle_stage: 'review_gate', status: 'active' });

  await expect(prepareExploration('raw-idea', { db, logger: quietLogger })).rejects.toThrow(
    'requires approved active opportunity',
  );
});

it('allows approved active opportunities', async () => {
  const db = getDb();
  initSchema(db);
  insertOpportunity(db, { slug: 'voice-looking', lifecycle_stage: 'approved', status: 'active' });

  const result = await prepareExploration('voice-looking', { db, logger: quietLogger });
  expect(result.status).toBe('awaiting_external_brief');
  expect(result.prompt).toContain('voice-looking');
});
```

Mock `generateExplorationJson` as in `research.test.ts` for the default engine path. Also add separate finalize tests that pass a validated brief object/file into the external Hermes/manual path.

**Step 2: Run tests to verify failure**

```bash
npx vitest run src/idea-maze/scripts/lib/exploration.test.ts --runInBand
```
Expected: FAIL because `exploreOpportunity` / `prepareExploration` do not exist.

**Step 3: Implement minimal `exploreOpportunity` and `prepareExploration` skeletons**

Add types:

```ts
export interface ExploreOpportunityOptions {
  db?: Database.Database;
  force?: boolean;
  logger?: Logger;
  requestedBy?: string;
}

export interface PreparedExplorationResult {
  context: { directEvidence: string[]; contextualResearch: string[] };
  opportunityId: number;
  opportunitySlug: string;
  outputSchema: string;
  prompt: string;
  runId: number;
  status: 'awaiting_external_brief';
}

export interface ExploreOpportunityResult {
  briefPath?: string;
  explorationArtifactId?: number;
  opportunityId: number;
  opportunitySlug: string;
  runId: number;
  status: 'completed' | 'needs_manual_exploration';
}

export interface FinalizeExplorationResult {
  briefPath?: string;
  explorationArtifactId?: number;
  opportunityId: number;
  opportunitySlug: string;
  runId: number;
  status: 'completed' | 'needs_manual_exploration';
}
```

Implement:
- open/init DB;
- load opportunity by slug;
- if not `approved` + `active` and `!force`, throw;
- create run with `createRun({ runType: 'explore', targetType: 'opportunity', targetId: String(opp.id) })`;
- record `explore.started` event;
- default `exploreOpportunity()` assembles context, calls `generateExplorationJson()`, validates, writes markdown, inserts `exploration_artifacts`, updates run status to `completed`;
- `prepareExploration()` assembles the same context but does not call an LLM; it returns prompt/context/schema and leaves the run status `awaiting_external_brief`;
- `finalizeExploration()` validates externally generated JSON and persists it with provider metadata;
- do not call `setOpportunityLifecycle` except optionally to re-set `approved` with metadata is unnecessary; instead update `opportunities.metadata_json` with `last_explored_at_utc` via `mergeOpportunityMetadata` to avoid lifecycle transition.

**Step 4: Verify pass**

```bash
npx vitest run src/idea-maze/scripts/lib/exploration.test.ts --runInBand
```
Expected: PASS.

**Commit:**
```bash
git add src/idea-maze/scripts/lib/exploration.ts src/idea-maze/scripts/lib/exploration.test.ts
git commit -m "feat: add approved opportunity exploration guard"
```

---

### Task 8: Add evidence/research context assembly tests first

**Objective:** Build useful prompts from existing approved draft + source refs.

**Files:**
- Modify: `src/idea-maze/scripts/lib/exploration.ts`
- Modify: `src/idea-maze/scripts/lib/exploration.test.ts`

**Step 1: Write failing tests**

Add a test that inserts:
- approved opportunity;
- previous approved research run with `metadata_json.draft`;
- two `source_items` linked through `opportunity_sources`;
- one `source='search'` contextual item.

Assert both the default engine prompt and prepared external packet include:
- approved draft thesis;
- direct source items;
- search item under contextual research;
- warning text that search is not independent buyer evidence.

Example assertion:

```ts
const result = await prepareExploration('client-help', { db, logger: quietLogger });
expect(result.prompt).toContain('Bookkeepers and small accounting firms');
expect(result.prompt).toContain('Direct Source Evidence');
expect(result.prompt).toContain('Contextual Research / Competitors');
expect(result.prompt).toContain('Do not count web search as independent buyer-pain evidence');
```

**Step 2: Run to verify failure**

```bash
npx vitest run src/idea-maze/scripts/lib/exploration.test.ts --runInBand
```
Expected: FAIL because context assembly is incomplete.

**Step 3: Implement context assembly**

In `exploration.ts` add helpers:

```ts
function latestApprovedDraft(db, opportunity): string { ... }
function loadDirectSourceEvidence(db, opportunityId): string[] { ... }
function loadContextualSearchEvidence(db, runIdOrOpportunityId): string[] { ... }
```

Rules:
- Use latest run for same opportunity where `status IN ('approved','published','review_gate')` and `metadata_json.draft` exists.
- Direct evidence excludes `source='search'` and `channel_or_label='tavily'`.
- Search/context evidence is separately passed as context only.
- Keep snippets bounded to ~500 chars each.

**Step 4: Verify pass**

```bash
npx vitest run src/idea-maze/scripts/lib/exploration.test.ts --runInBand
```
Expected: PASS.

**Commit:**
```bash
git add src/idea-maze/scripts/lib/exploration.ts src/idea-maze/scripts/lib/exploration.test.ts
git commit -m "feat: assemble exploration evidence context"
```

---

### Task 9: Add finalize validation/fallback tests first

**Objective:** Avoid pretending deep exploration exists when Hermes returns invalid JSON or no brief.

**Files:**
- Modify: `src/idea-maze/scripts/lib/exploration.ts`
- Modify: `src/idea-maze/scripts/lib/exploration.test.ts`

**Step 1: Write failing test**

```ts
it('returns needs_manual_exploration when external brief validation fails', async () => {
  const db = getDb();
  initSchema(db);
  insertOpportunity(db, { slug: 'voice-looking', lifecycle_stage: 'approved', status: 'active' });
  const prepared = await prepareExploration('voice-looking', { db, logger: quietLogger });

  const result = await finalizeExploration(prepared.runId, {
    db,
    brief: { thesis: 'too thin' },
    logger: quietLogger,
    providerMetadata: { orchestrator: 'hermes', model: 'gpt-5.5', provider: 'openai-codex' },
  });

  expect(result.status).toBe('needs_manual_exploration');
  const run = db.prepare('SELECT status, metadata_json FROM runs WHERE id=?').get(result.runId) as any;
  expect(run.status).toBe('needs_manual_exploration');
  expect(JSON.parse(run.metadata_json).prompt_metadata.validation_status).toBe('invalid_external_brief');
});
```

**Step 2: Run to verify failure**

```bash
npx vitest run src/idea-maze/scripts/lib/exploration.test.ts --runInBand
```
Expected: FAIL because fallback not implemented.

**Step 3: Implement fallback behavior**

When external brief validation fails:
- do not create a polished exploration artifact from partial data;
- mark run `needs_manual_exploration`;
- record `explore.needs_manual_exploration` warning event;
- include validation errors and `provider_metadata` in `metadata_json.prompt_metadata`;
- return the original prepare packet/run id so Hermes can retry with the same context.

**Step 4: Verify pass**

```bash
npx vitest run src/idea-maze/scripts/lib/exploration.test.ts --runInBand
```
Expected: PASS.

**Commit:**
```bash
git add src/idea-maze/scripts/lib/exploration.ts src/idea-maze/scripts/lib/exploration.test.ts
git commit -m "feat: handle exploration fallback states"
```

---

## Phase 6: Add CLI command

### Task 10: Add `explore-opportunity.ts` CLI tests via direct script contract

**Objective:** Create a CLI wrapper consistent with `research-opportunity.ts`.

**Files:**
- Create: `src/idea-maze/scripts/explore-opportunity.ts`
- Modify: `package.json`

**Step 1: Write command file minimal after library is tested**

Create `explore-opportunity.ts`:

```ts
import { readFileSync } from 'node:fs';
import { getOption, getPositional, hasFlag, writeJson } from './lib/cli.ts';
import { exploreOpportunity, finalizeExploration, prepareExploration } from './lib/exploration.ts';

function loggerFor(json: boolean) {
  return json
    ? { log: (...args: any[]) => console.error(...args), warn: (...args: any[]) => console.error(...args) }
    : console;
}

async function main() {
  const json = hasFlag('--json');
  const runIdRaw = getOption('--run-id');
  const briefFile = getOption('--brief-file');

  if (runIdRaw && briefFile) {
    const result = await finalizeExploration(Number(runIdRaw), {
      brief: JSON.parse(readFileSync(briefFile, 'utf-8')),
      logger: loggerFor(json),
      providerMetadata: JSON.parse(getOption('--provider-metadata') ?? '{}'),
      requestedBy: 'hermes',
    });
    if (json) writeJson(result);
    return;
  }

  const target = getOption('--id') ?? getOption('--slug') ?? getPositional(0);
  if (!target) {
    console.error('Usage: tsx explore-opportunity.ts <slug-or-id> [--json] [--force] [--prepare-only] OR --run-id <id> --brief-file <path> [--json]');
    process.exit(1);
  }

  const result = hasFlag('--prepare-only')
    ? await prepareExploration(target, {
        force: hasFlag('--force'),
        logger: loggerFor(json),
        requestedBy: 'user',
      })
    : await exploreOpportunity(target, {
        force: hasFlag('--force'),
        logger: loggerFor(json),
        requestedBy: 'user',
      });

  if (json) writeJson(result);
}

main().catch((err) => {
  console.error('Explore failed:', err);
  process.exit(1);
});
```

Add script to `package.json`:

```json
"idea:explore": "tsx src/idea-maze/scripts/explore-opportunity.ts"
```

**Step 2: Verify typecheck**

```bash
npm run typecheck
```
Expected: PASS.

**Step 3: Verify missing-arg behavior**

```bash
npm run idea:explore
```
Expected: exits non-zero and prints usage.

**Commit:**
```bash
git add package.json src/idea-maze/scripts/explore-opportunity.ts
git commit -m "feat: add idea explore CLI"
```

---

## Phase 7: Add listing/observability support

### Task 11: Add exploration count to status snapshot tests first

**Objective:** Make it visible that exploration briefs exist.

**Files:**
- Modify: `src/idea-maze/scripts/lib/queries.ts`
- Modify: `src/idea-maze/scripts/lib/observability.ts`
- Modify: `src/idea-maze/scripts/lib/observability.test.ts`

**Step 1: Write failing test**

In `observability.test.ts`, insert an `exploration_artifacts` row and assert snapshot/markdown includes exploration count or latest exploration.

Expected field shape:

```ts
expect(snapshot.counts.exploration_artifacts).toBe(1);
```

**Step 2: Run to verify failure**

```bash
npx vitest run src/idea-maze/scripts/lib/observability.test.ts --runInBand
```
Expected: FAIL because counts do not include explorations.

**Step 3: Implement counts**

Update `getCounts()` in `queries.ts` to add `exploration_artifacts`. Update `LatestSnapshot` / `buildLatestSnapshot` if needed.

Keep existing `artifacts` count unchanged.

**Step 4: Verify pass**

```bash
npx vitest run src/idea-maze/scripts/lib/observability.test.ts --runInBand
```
Expected: PASS.

**Commit:**
```bash
git add src/idea-maze/scripts/lib/queries.ts src/idea-maze/scripts/lib/observability.ts src/idea-maze/scripts/lib/observability.test.ts
git commit -m "feat: surface exploration brief counts"
```

---

### Task 12: Add optional `idea:explorations` list command

**Objective:** Let Hermes list recent exploration briefs without ad hoc SQL.

**Files:**
- Create: `src/idea-maze/scripts/list-explorations.ts`
- Modify: `package.json`

**Step 1: Implement simple read-only CLI**

The command should support:

```bash
npm run idea:explorations -- --json --limit 20
```

Return rows:

```ts
{
  id: number;
  opportunity_slug: string;
  opportunity_title: string;
  run_id: number;
  path: string;
  created_at_utc: string;
  next_action: string;
}
```

Read `next_action` from `brief_json`.

**Step 2: Verify manually**

```bash
npm run idea:explorations -- --json --limit 5
```
Expected: valid JSON array, possibly empty.

**Commit:**
```bash
git add package.json src/idea-maze/scripts/list-explorations.ts
git commit -m "feat: list exploration briefs"
```

---

## Phase 8: End-to-end verification on real approved opportunity

### Task 13: Run focused tests and typecheck

**Objective:** Validate implementation before touching runtime data.

**Commands:**
```bash
npm run typecheck
npx vitest run \
  src/idea-maze/scripts/lib/validation.test.ts \
  src/idea-maze/scripts/lib/prompts.test.ts \
  src/idea-maze/scripts/lib/schema.test.ts \
  src/idea-maze/scripts/lib/exploration.test.ts \
  src/idea-maze/scripts/lib/observability.test.ts \
  --runInBand
```

Expected: PASS.

---

### Task 14: Run full test suite

**Objective:** Catch regressions outside exploration code.

**Command:**
```bash
npm test
```
Expected: PASS.

---

### Task 15: Dry-run real command on an approved opportunity

**Objective:** Verify command works against current runtime data.

**Command:**
```bash
set -a; . /home/hermes/.hermes/.env; set +a; IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:explore -- --id voice-looking --json
```

Expected default engine JSON:

```json
{
  "opportunitySlug": "voice-looking",
  "status": "completed",
  "briefPath": "/workspace/idea-maze/data/explorations/.../voice-looking.md",
  "runId": 123,
  "explorationArtifactId": 1
}
```

Also verify Hermes/manual handoff mode:

```bash
set -a; . /home/hermes/.hermes/.env; set +a; IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:explore -- --id voice-looking --prepare-only --json
```

Expected prepare JSON includes `status: "awaiting_external_brief"`, `prompt`, `outputSchema`, and `runId`. Hermes then calls its current provider/model to produce a brief JSON file and finalizes it:

```bash
set -a; . /home/hermes/.hermes/.env; set +a; IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:explore -- --run-id 123 --brief-file /tmp/voice-looking-exploration.json --provider-metadata '{"orchestrator":"hermes","provider":"openai-codex","model":"gpt-5.5"}' --json
```

Expected finalize JSON:

```json
{
  "opportunitySlug": "voice-looking",
  "status": "completed",
  "briefPath": "/workspace/idea-maze/data/explorations/.../voice-looking.md",
  "runId": 123,
  "explorationArtifactId": 1
}
```

If Hermes cannot produce valid JSON or validation fails, acceptable status is `needs_manual_exploration` with warning metadata; do not claim deep exploration succeeded. Search provider failure only reduces contextual research and should be recorded as a warning.

---

### Task 16: Verify DB invariants after real run

**Objective:** Ensure exploration did not publish or mutate approval state.

**Command:**
```bash
node - <<'NODE'
const Database=require('better-sqlite3');
const db=new Database('/workspace/idea-maze/data/lab.db',{readonly:true});
const slug='voice-looking';
const row=db.prepare(`
SELECT o.slug,o.lifecycle_stage,o.status,
       (SELECT COUNT(*) FROM artifacts a WHERE a.opportunity_id=o.id) artifact_count,
       (SELECT COUNT(*) FROM exploration_artifacts e WHERE e.opportunity_id=o.id) exploration_count
FROM opportunities o
WHERE o.slug=?
`).get(slug);
console.log(JSON.stringify(row,null,2));
db.close();
NODE
```

Expected:
```json
{
  "slug": "voice-looking",
  "lifecycle_stage": "approved",
  "status": "active",
  "artifact_count": 0,
  "exploration_count": 1
}
```

---

### Task 17: Run status and list commands

**Objective:** Confirm Hermes-facing contracts.

**Commands:**
```bash
set -a; . /home/hermes/.hermes/.env; set +a; IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:status -- --json
set -a; . /home/hermes/.hermes/.env; set +a; IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:explorations -- --json --limit 5
```

Expected:
- status includes exploration count if implemented in observability;
- explorations list includes the new `voice-looking` row.

---

## Future Follow-Ups

- Add `idea:explore --all-approved --limit N` after single-opportunity command is stable.
- Add `idea:explore --dry-run` if real runtime use shows a need to preview target selection.
- Add exploration quality scoring after 5–10 briefs have been reviewed.
- Add export support to a separate exploration repo only after artifact semantics are settled.
- Add Hermes skill update once command is implemented:
  ```bash
  set -a; . /home/hermes/.hermes/.env; set +a; IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:explore -- --id <slug> --json
  set -a; . /home/hermes/.hermes/.env; set +a; IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:explorations -- --json --limit 20
  ```

---

## Implementation Notes / Pitfalls

- `setOpportunityLifecycle()` intentionally preserves `approved` and `rejected`; do not fight this. Exploration should record run events and metadata, not lifecycle transitions.
- `source='search'` / `channel_or_label='tavily'` is context, not buyer evidence.
- Default exploration should use `lib/llm.ts` and never call Anthropic/OpenAI/OpenAI-compatible APIs directly. Stage-specific model names belong in `lib/llm.ts` env-overridable routing, not scattered through exploration code. Hermes/manual mode supplies external brief JSON and provider metadata into finalize.
- Keep exploration files under `DATA_DIR/explorations`, not `DATA_DIR/artifacts`, because existing artifacts imply publication/export semantics.
- Keep template fallback honest: `needs_manual_exploration` means no true deep research was produced.
- Use strict TDD for every production-code task above.
