# Remove Artifact Mirroring Implementation Plan

> **For Hermes:** Implement directly in `idea-maze-engine` with TDD/focused tests first. Do not delete runtime artifact files or production SQLite data without explicit approval.

**Goal:** Remove the obsolete GitHub mirroring/export path to `idea-maze-artifacts` while preserving local research artifact publication and the newer exploration flow.

**Architecture:** Keep `artifacts` as the local publication record and keep `idea:artifacts` as a local artifact listing command. Remove the separate mirror/export concern: no `IDEA_MAZE_ARTIFACTS_REPO_*` config, no `artifact_exports` writes, no IPC task wakeups for host export, no export status in artifact reports. Existing runtime DB tables/files are not deleted by this implementation; they simply become unused legacy data unless Kostya separately approves a destructive cleanup.

**Tech Stack:** TypeScript, Vitest, better-sqlite3, npm scripts in `/home/hermes/workspace/idea-maze-engine`.

---

## Current Findings

Relevant files/refs discovered before planning:

- `src/idea-maze/scripts/lib/artifact-export.ts` — dedicated mirror/export queue module.
- `src/idea-maze/scripts/lib/review.ts` — imports export module, reads `IDEA_MAZE_ARTIFACTS_REPO_URL` / `_BRANCH`, queues export during `publishResearchArtifact`.
- `src/idea-maze/scripts/lib/schema.ts` — creates `artifact_exports` table and indexes.
- `src/idea-maze/scripts/lib/observability.ts` — joins `artifact_exports` and shows export status in artifact snapshots/reports.
- `src/idea-maze/scripts/lib/review.test.ts` — tests disabled/queued export behavior and IPC wakeups.
- `src/idea-maze/scripts/lib/schema.test.ts` — expects `artifact_exports` table creation.
- `src/idea-maze/scripts/lib/observability.test.ts` — artifact snapshot test currently tolerates export fields.
- `CLAUDE.md` — documents `artifact-export.ts` and `IDEA_MAZE_ARTIFACTS_REPO_URL` / `_BRANCH`.
- Hermes `idea-maze` skill currently mentions artifacts/export status; patch after implementation if behavior changes.

Non-goals:

- Do **not** remove `artifacts` table or local artifact markdown generation under `data/artifacts/...`.
- Do **not** remove `idea:artifacts`; it remains useful for local artifacts.
- Do **not** drop existing production `artifact_exports` rows/table in `/workspace/idea-maze/data/lab.db` without explicit approval.
- Do **not** touch `idea:explore` / `exploration_artifacts` except to verify no regression.

---

### Task 1: Create cleanup branch and baseline verification

**Objective:** Start from clean `main`, isolate work on an agent branch, and capture baseline test status.

**Files:**
- No source edits.

**Steps:**

1. Check status:
   ```bash
   git status --short --branch
   ```
   Expected: `## main...origin/main` and no local changes except this plan if already written.

2. Create branch:
   ```bash
   git switch -c agent/remove-artifact-mirroring
   ```

3. Run targeted baseline tests:
   ```bash
   npm test -- src/idea-maze/scripts/lib/review.test.ts src/idea-maze/scripts/lib/schema.test.ts src/idea-maze/scripts/lib/observability.test.ts
   ```
   Expected: pass before code changes.

---

### Task 2: Remove export behavior from artifact publication tests first

**Objective:** Define the new contract: publication creates a local artifact and publication event, but never queues mirror export or writes IPC tasks.

**Files:**
- Modify: `src/idea-maze/scripts/lib/review.test.ts`

**Changes:**

1. Remove export-env cleanup from `beforeEach` / `afterEach`:
   - Delete `delete process.env.IDEA_MAZE_ARTIFACTS_REPO_BRANCH;`
   - Delete `delete process.env.IDEA_MAZE_ARTIFACTS_REPO_URL;`

2. Replace test name:
   - From: `records publication feedback and leaves GitHub export disabled when mirror config is absent`
   - To: `records publication feedback and writes only a local artifact`

3. Update assertions in the first publication test:
   - Remove `expect(result.githubExport.status).toBe('disabled');`
   - Remove the `artifact_exports` count query.
   - Remove assertion that payload contains `"github_export_status":"disabled"`.
   - Add assertions that:
     ```ts
     expect(result.path).toContain(path.join('data', 'artifacts', '2026', '04', '18', 'finance-ops.md'));
     expect(fs.existsSync(result.path)).toBe(true);
     expect(fs.existsSync(path.join(ipcDir, 'tasks'))).toBe(false);
     ```

4. Delete the entire test `queues a host-side GitHub export row and writes an IPC wakeup when mirror config is present`.

5. Run focused test and verify it fails because implementation still returns/queues export shape:
   ```bash
   npm test -- src/idea-maze/scripts/lib/review.test.ts
   ```
   Expected: fail until implementation is updated.

---

### Task 3: Remove mirror/export implementation from publication code

**Objective:** Make `publishResearchArtifact` local-only.

**Files:**
- Modify: `src/idea-maze/scripts/lib/review.ts`
- Delete: `src/idea-maze/scripts/lib/artifact-export.ts`

**Changes in `review.ts`:**

1. Remove import from `./artifact-export.ts`:
   ```ts
   import {
     artifactSourceRelativePath,
     queueGitHubArtifactExport,
     resolveArtifactPath,
     type GitHubExportState,
   } from './artifact-export.ts';
   ```

2. Inline local artifact path helpers into `review.ts`:
   ```ts
   import { posix, resolve } from 'node:path';
   import { IDEA_MAZE_HOME } from './paths.ts';

   const ARTIFACT_SOURCE_PREFIX = 'data/artifacts';
   const ARTIFACT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

   function artifactSourceRelativePath(slug: string, timestamp = new Date()): string {
     if (!ARTIFACT_SLUG_PATTERN.test(slug)) {
       throw new Error(`Invalid artifact slug: ${slug}`);
     }
     const y = timestamp.getUTCFullYear();
     const m = String(timestamp.getUTCMonth() + 1).padStart(2, '0');
     const d = String(timestamp.getUTCDate()).padStart(2, '0');
     return posix.join(ARTIFACT_SOURCE_PREFIX, String(y), m, d, `${slug}.md`);
   }

   function resolveArtifactPath(relativePath: string): string {
     return resolve(IDEA_MAZE_HOME, ...relativePath.split('/'));
   }
   ```

3. Remove constants:
   ```ts
   const ARTIFACTS_REPO_URL = ...
   const ARTIFACTS_REPO_BRANCH = ...
   ```

4. Change `publishResearchArtifact` return type from:
   ```ts
   githubExport: GitHubExportState;
   path: string;
   opportunityId: number;
   draft: ResearchDraft;
   ```
   to:
   ```ts
   path: string;
   opportunityId: number;
   draft: ResearchDraft;
   ```

5. Remove the `const githubExport = queueGitHubArtifactExport(...)` block entirely.

6. Remove mirror fields from `artifact.published` payload:
   - `github_export_repo_branch`
   - `github_export_repo_url`
   - `github_export_status`

7. Return:
   ```ts
   return { path, opportunityId, draft };
   ```

8. Delete `src/idea-maze/scripts/lib/artifact-export.ts` after imports are gone.

9. Run focused test:
   ```bash
   npm test -- src/idea-maze/scripts/lib/review.test.ts
   ```
   Expected: pass.

---

### Task 4: Remove `artifact_exports` schema creation and schema test expectation

**Objective:** Stop creating new mirror/export DB structures.

**Files:**
- Modify: `src/idea-maze/scripts/lib/schema.ts`
- Modify: `src/idea-maze/scripts/lib/schema.test.ts`

**Changes in `schema.ts`:**

Remove this block entirely:

```sql
CREATE TABLE IF NOT EXISTS artifact_exports (...);
CREATE INDEX IF NOT EXISTS ix_artifact_exports_status ...;
CREATE INDEX IF NOT EXISTS ix_artifact_exports_updated_at_utc ...;
CREATE INDEX IF NOT EXISTS ix_artifact_exports_last_attempt_at_utc ...;
```

**Changes in `schema.test.ts`:**

Remove the assertion that queries `sqlite_master` for `artifact_exports`.

**Verification:**

```bash
npm test -- src/idea-maze/scripts/lib/schema.test.ts
```

Expected: pass, proving migrations/backfills still work without creating mirror tables.

---

### Task 5: Simplify artifact observability/listing output

**Objective:** Make artifact snapshots/reports local-only and remove export-status fields.

**Files:**
- Modify: `src/idea-maze/scripts/lib/observability.ts`
- Modify: `src/idea-maze/scripts/lib/observability.test.ts`
- Indirectly verified: `src/idea-maze/scripts/list-artifacts.ts`

**Changes in `observability.ts`:**

1. In `ArtifactsSnapshot` item type, remove:
   - `export_status`
   - `export_attempt_count`
   - `export_commit_sha`
   - `export_last_error`

2. In `buildArtifactsSnapshot`, remove:
   - `LEFT JOIN artifact_exports ae ON ae.artifact_id = a.id`
   - selected `ae.*` fields.

3. In `buildArtifactsReport`, replace export-aware line building:
   ```ts
   const exportStatus = ...
   const commit = ...
   lines.push(`- ...${exportStatus}${commit} — ${artifact.path}`)
   if (artifact.export_last_error) ...
   ```
   with local-only output:
   ```ts
   lines.push(
     `- ${artifact.created_at_utc}: ${artifact.opportunity_slug} run #${artifact.run_id} — ${artifact.path}`,
   );
   ```

**Changes in tests:**

Add/adjust assertions in `observability.test.ts` so artifact snapshot objects do not expose export fields:

```ts
expect(artifacts.artifacts[0]).toMatchObject({
  opportunity_slug: 'finance-ops',
  path: '/tmp/finance-ops.md',
});
expect(artifacts.artifacts[0]).not.toHaveProperty('export_status');
```

**Verification:**

```bash
npm test -- src/idea-maze/scripts/lib/observability.test.ts
```

Expected: pass.

---

### Task 6: Clean documentation and repo metadata references

**Objective:** Remove docs that advertise the obsolete mirror/export behavior.

**Files:**
- Modify: `CLAUDE.md`
- Modify after implementation: Hermes skill `idea-maze` via `skill_manage`, because user-facing command guidance currently says to mention export status.
- Search-confirm no more code/docs refs.

**Changes in `CLAUDE.md`:**

1. In key library module table, delete row:
   ```md
   | `artifact-export.ts` | GitHub repository push logic |
   ```

2. In environment variables table, delete row:
   ```md
   | `IDEA_MAZE_ARTIFACTS_REPO_URL` / `_BRANCH` | GitHub export target |
   ```

3. Optional wording cleanup: artifact publication is local-only under `data/artifacts/...`.

**Hermes skill patch after code changes:**

Patch `idea-maze` skill:

- Replace “Return artifact paths and mention export status when available.” with “Return local artifact paths.”
- Remove any future mention of GitHub artifact export if found.

**Verification search:**

```bash
rg "IDEA_MAZE_ARTIFACTS_REPO|artifact_exports|artifact-export|queueGitHubArtifactExport|github_export|artifact_export\.queued|idea-maze-artifacts" .
```

Expected after implementation:

- No source/test/docs references, except possibly historical plan text under `docs/plans/2026-06-21-remove-artifact-mirroring.md` if we keep the plan as audit context.

---

### Task 7: Full verification and runtime smoke tests

**Objective:** Prove local artifact publication, artifact listing, and exploration still work.

**Commands:**

1. Typecheck:
   ```bash
   npm run typecheck
   ```
   Expected: pass.

2. Full tests:
   ```bash
   npm test
   ```
   Expected: pass.

3. Runtime read-only artifact listing:
   ```bash
   IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:artifacts -- --json --limit 5
   ```
   Expected: valid JSON; no `export_status` / mirror fields in output.

4. Runtime exploration listing to guard the replacement path:
   ```bash
   IDEA_MAZE_HOME=/workspace/idea-maze npm run idea:explorations -- --json --limit 5
   ```
   Expected: valid JSON from `exploration_artifacts`; unchanged by this cleanup.

5. Optional non-production publication smoke can be done only in a temp `IDEA_MAZE_HOME` via tests; do not publish real production drafts unless explicitly requested.

---

### Task 8: Diff review, commit, push/merge only after approval

**Objective:** Keep the cleanup reviewable and safe.

**Steps:**

1. Show summary:
   ```bash
   git status --short
   git diff --stat
   git diff
   ```

2. Commit after approval or if Kostya explicitly authorizes implementation+commit:
   ```bash
   git add docs/plans/2026-06-21-remove-artifact-mirroring.md CLAUDE.md src/idea-maze/scripts/lib src/idea-maze/scripts/list-artifacts.ts
   git commit -m "refactor: remove artifact repository mirroring"
   ```

3. Push/merge only with explicit approval:
   ```bash
   git push -u origin agent/remove-artifact-mirroring
   git switch main
   git merge --no-ff agent/remove-artifact-mirroring
   git push origin main
   ```

---

## Acceptance Criteria

- `publishResearchArtifact` still writes local markdown and DB `artifacts` row.
- No code path reads `IDEA_MAZE_ARTIFACTS_REPO_URL` or `IDEA_MAZE_ARTIFACTS_REPO_BRANCH`.
- No code creates/writes/joins `artifact_exports` for new DBs.
- No IPC task file is emitted for artifact export.
- `idea:artifacts -- --json` returns local artifact metadata without mirror/export fields.
- `idea:explorations -- --json` still works unchanged.
- `npm run typecheck` passes.
- `npm test` passes.

## Open Decision

Should we also drop the existing `artifact_exports` table from the live `/workspace/idea-maze/data/lab.db`? Recommendation: **no for this implementation**. It is destructive cleanup of historical metadata and not needed to stop using the repo. If desired later, do it as a separate explicitly approved DB maintenance task with backup first.
