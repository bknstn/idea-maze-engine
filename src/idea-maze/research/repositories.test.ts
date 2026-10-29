import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type { ResearchAssessment, ResearchEvidence } from './contracts.ts';
import { migrateResearchSchema } from './migrations.ts';
import type { ResearchClock, ResearchIdKind, ResearchRepositories } from './repositories.ts';
import {
  ActiveWorkspaceLeaseError,
  CaseRevisionConflictError,
  ExternalOperationOutcomeUnknownError,
  ExternalOperationPendingError,
  HypothesisRevisionConflictError,
  IdempotencyConflictError,
  ImmutableRecordConflictError,
  StaleWorkspaceLeaseError,
  createResearchRepositories,
} from './repositories.ts';
import { initSchema } from '../scripts/lib/schema.ts';

const databases: Database.Database[] = [];
const scratchDirectories: string[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
  for (const directory of scratchDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function database(filename = ':memory:'): Database.Database {
  const db = new Database(filename);
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  initSchema(db);
  return db;
}

function repositories(
  db: Database.Database,
  workspaceKey = 'workspace-a',
  options: { now?: () => number; ids?: () => string } = {},
): { repos: ResearchRepositories; advance(milliseconds: number): void } {
  let now = options.now?.() ?? Date.parse('2026-01-01T00:00:00.000Z');
  let nextId = 0;
  const clock: ResearchClock = () => new Date(now);
  const idFactory = (kind: ResearchIdKind) => options.ids?.() ?? `${workspaceKey}_${kind}_${++nextId}`;
  return {
    repos: createResearchRepositories({ db, workspaceKey, clock, idFactory }),
    advance(milliseconds) { now += milliseconds; },
  };
}

function seedSource(db: Database.Database, text: string): number {
  return Number(db.prepare(`
    INSERT INTO source_items(source, external_id, text, timestamp_utc, ingested_at_utc, raw_path, content_hash)
    VALUES ('synthetic', 'source-1', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'synthetic', 'synthetic-hash')
  `).run(text).lastInsertRowid);
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function createRunnableCase(repos: ResearchRepositories) {
  const created = repos.cases.create({
    intake: { ideaSummary: 'A synthetic workflow helper', problem: 'A recurring manual task takes time.' },
    hypotheses: [{ claim: 'Small teams repeat this task every week.' }],
  });
  const hypothesis = created.hypothesisRevisions[0];
  const plan = repos.plans.create({
    caseId: created.caseId,
    caseRevision: created.revision,
    queries: [{
      text: 'How do small teams handle recurring manual tasks?',
      purpose: 'problem_language',
      evidenceIntent: 'supporting',
      hypothesisIds: [hypothesis.hypothesisId],
      sourceScopes: ['public_web'],
    }],
    limits: {
      maxQueries: 2,
      maxFetchedPages: 2,
      maxFollowUpRounds: 0,
      maxWallTimeSeconds: 30,
      maxModelInputTokens: 2000,
      maxModelOutputTokens: 1000,
    },
  });
  const run = repos.runs.create({ caseId: created.caseId, caseRevision: created.revision, planId: plan.planId });
  return { created, hypothesis, plan, run };
}

describe('hypothesis research repositories', () => {
  it('migrates fresh and existing synthetic databases idempotently while preserving legacy rows', () => {
    const legacy = new Database(':memory:');
    databases.push(legacy);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE source_items(id INTEGER PRIMARY KEY, text TEXT NOT NULL);
      CREATE TABLE legacy_records(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      INSERT INTO source_items(id, text) VALUES (7, 'Synthetic legacy source text.');
      INSERT INTO legacy_records(id, payload) VALUES (3, '{"kept":true}');
    `);
    const legacySourceBefore = legacy.prepare('SELECT * FROM source_items').all();
    const legacyRecordBefore = legacy.prepare('SELECT * FROM legacy_records').all();
    migrateResearchSchema(legacy);
    migrateResearchSchema(legacy);

    expect(legacy.prepare('SELECT * FROM source_items').all()).toEqual(legacySourceBefore);
    expect(legacy.prepare('SELECT * FROM legacy_records').all()).toEqual(legacyRecordBefore);
    expect(legacy.prepare('SELECT version FROM research_schema_migrations').all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_runs'").get()).toEqual({ name: 'research_runs' });
    expect(legacy.pragma('foreign_keys', { simple: true })).toBe(1);

    const fresh = new Database(':memory:');
    databases.push(fresh);
    fresh.pragma('foreign_keys = ON');
    fresh.exec('CREATE TABLE source_items(id INTEGER PRIMARY KEY)');
    migrateResearchSchema(fresh);
    migrateResearchSchema(fresh);
    expect(fresh.prepare('SELECT version FROM research_schema_migrations').all()).toEqual([{ version: 1 }, { version: 2 }]);
    fresh.exec(`DROP TABLE research_external_operations; DELETE FROM research_schema_migrations WHERE version = 2;`);
    migrateResearchSchema(fresh);
    expect(fresh.prepare('SELECT version FROM research_schema_migrations').all()).toEqual([{ version: 1 }, { version: 2 }]);
    expect(fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'research_external_operations'").get())
      .toEqual({ name: 'research_external_operations' });
  });

  it('stores append-only case and hypothesis revisions with suggestion provenance and stale revision conflicts', () => {
    const db = database();
    const { repos } = repositories(db);
    const suggestion = repos.suggestions.create('Teams may use spreadsheets as a workaround.');
    const first = repos.cases.create({
      intake: { ideaSummary: 'Synthetic idea', currentAlternatives: [] },
      hypotheses: [
        { claim: 'Teams repeat a manual workflow weekly.' },
        { claim: suggestion.claim, origin: 'model_suggested', sourceSuggestionId: suggestion.suggestionId },
      ],
    });
    const userHypothesis = first.hypothesisRevisions[0];
    const modelHypothesis = first.hypothesisRevisions[1];

    const second = repos.cases.update({
      caseId: first.caseId,
      expectedRevision: 1,
      intakePatch: { problem: 'A synthetic recurring task is slow.' },
      hypothesisMutations: [{
        operation: 'revise',
        hypothesisId: userHypothesis.hypothesisId,
        expectedRevision: 1,
        claim: 'Small teams repeat a manual workflow weekly.',
      }],
    });

    expect(second.revision).toBe(2);
    expect(second.hypothesisRevisions.find((item) => item.hypothesisId === userHypothesis.hypothesisId)).toMatchObject({ revision: 2, origin: 'user_supplied' });
    expect(second.hypothesisRevisions.find((item) => item.hypothesisId === modelHypothesis.hypothesisId)).toMatchObject({
      revision: 1,
      origin: 'model_suggested',
      sourceSuggestionId: suggestion.suggestionId,
    });
    expect(repos.cases.get(first.caseId, 1)).toEqual(first);
    expect(repos.cases.get(first.caseId)?.intake.problem).toBe('A synthetic recurring task is slow.');
    expect(() => db.prepare(`UPDATE research_case_revisions SET snapshot_json = '{}' WHERE workspace_key = ? AND case_id = ? AND revision = 1`)
      .run('workspace-a', first.caseId)).toThrow(/immutable/);
    expect(() => repos.cases.update({ caseId: first.caseId, expectedRevision: 1, intakePatch: { decisionMaker: 'Unknown' } }))
      .toThrow(CaseRevisionConflictError);
    expect(() => repos.cases.update({
      caseId: first.caseId,
      expectedRevision: 2,
      hypothesisMutations: [{ operation: 'retire', hypothesisId: userHypothesis.hypothesisId, expectedRevision: 1 }],
    })).toThrow(HypothesisRevisionConflictError);

    const otherWorkspace = repositories(db, 'workspace-b').repos;
    expect(otherWorkspace.cases.get(first.caseId)).toBeNull();
    expect(otherWorkspace.suggestions.exists(suggestion.suggestionId)).toBe(false);
  });

  it('atomically cross-checks synchronous receipts against pending external reservations', () => {
    const db = database();
    const { repos } = repositories(db);
    const input = {
      idempotencyKey: 'external-plan-reservation-key-001',
      caseId: 'case_1',
      expectedCaseRevision: 1,
      requestHypothesisSuggestions: true,
    };
    const reservation = repos.externalOperations.reserve({
      operation: 'research_plan',
      key: input.idempotencyKey,
      validatedInput: input,
      ownerId: 'synthetic-owner-a',
      deadlineAt: '2026-01-01T00:02:00.000Z',
    });
    expect(reservation.kind).toBe('claimed');

    let synchronousEffectCalled = false;
    expect(() => repos.idempotency.execute('research_plan', input.idempotencyKey, input, () => {
      synchronousEffectCalled = true;
      return { result: 'must not run' };
    })).toThrow(ExternalOperationPendingError);
    expect(synchronousEffectCalled).toBe(false);

    expect(() => repos.idempotency.execute('research_plan', input.idempotencyKey, {
      ...input,
      requestHypothesisSuggestions: false,
    }, () => ({ result: 'different payload' }))).toThrow(IdempotencyConflictError);
  });

  it('commits an expired external claim as unknown before throwing from synchronous idempotency', () => {
    const db = database();
    const { repos, advance } = repositories(db);
    const input = {
      idempotencyKey: 'expired-research-plan-key-001',
      caseId: 'case_1',
      expectedCaseRevision: 1,
      requestHypothesisSuggestions: true,
    };
    repos.externalOperations.reserve({
      operation: 'research_plan',
      key: input.idempotencyKey,
      validatedInput: input,
      ownerId: 'synthetic-owner-expired',
      deadlineAt: '2026-01-01T00:00:01.000Z',
    });
    advance(2_000);

    expect(() => repos.idempotency.execute('research_plan', input.idempotencyKey, input, () => ({ result: 'must not run' })))
      .toThrow(ExternalOperationOutcomeUnknownError);
    expect(db.prepare('SELECT status FROM research_external_operations WHERE idempotency_key = ?')
      .get(input.idempotencyKey)).toEqual({ status: 'unknown' });
  });

  it('binds plans and immutable run snapshots to the same workspace, case, and hypothesis revisions', () => {
    const db = database();
    const { repos } = repositories(db);
    const { created, hypothesis, plan, run } = createRunnableCase(repos);
    const sameWorkspaceOther = createRunnableCase(repos);
    const otherRepos = repositories(db, 'workspace-b').repos;
    const other = createRunnableCase(otherRepos);

    expect(() => db.prepare(`
      INSERT INTO research_plan_query_hypotheses(workspace_key, plan_id, case_id, query_id, hypothesis_id, hypothesis_revision)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run('workspace-a', plan.planId, sameWorkspaceOther.created.caseId, plan.queries[0].queryId, sameWorkspaceOther.hypothesis.hypothesisId)).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare(`
      INSERT INTO research_run_hypotheses(workspace_key, run_id, case_id, hypothesis_id, hypothesis_revision)
      VALUES (?, ?, ?, ?, 1)
    `).run('workspace-a', run.runId, sameWorkspaceOther.created.caseId, sameWorkspaceOther.hypothesis.hypothesisId)).toThrow(/FOREIGN KEY/);
    expect(() => repos.runs.create({ caseId: other.created.caseId, caseRevision: 1, planId: plan.planId })).toThrow();
    expect(() => db.prepare(`UPDATE research_runs SET snapshot_json = '{}' WHERE workspace_key = ? AND run_id = ?`)
      .run('workspace-a', run.runId)).toThrow(/immutable/);

    repos.cases.update({ caseId: created.caseId, expectedRevision: 1, intakePatch: { targetUser: 'A synthetic user group.' } });
    expect(repos.runs.get(run.runId)?.snapshot.caseRevision).toEqual(created);
    expect(repos.runs.get(run.runId)?.snapshot.plan).toEqual(plan);
    expect(repos.runs.get(run.runId)?.snapshot.caseRevision.hypothesisRevisions[0].hypothesisId).toBe(hypothesis.hypothesisId);
  });

  it('stores immutable fetched source versions, checks excerpt offsets, and permits only linked evidence in assessments', () => {
    const db = database();
    const { repos } = repositories(db);
    const sourceText = 'Synthetic fetched original: teams repeat a manual task every week.';
    const sourceItemId = seedSource(db, sourceText);
    const { hypothesis, run } = createRunnableCase(repos);
    const lease = repos.leases.acquire({ runId: run.runId, ownerInstanceId: 'worker-a', ttlMilliseconds: 60_000 });
    const retrievedAt = '2026-01-01T00:00:01.000Z';
    const sourceHash = hash(sourceText);
    const startUtf16 = sourceText.indexOf('teams repeat a manual task');
    const quote = 'teams repeat a manual task';
    const sourceInput = {
      runId: run.runId,
      sourceItemId,
      sourceText,
      sourceTextHash: sourceHash,
      canonicalUrl: 'https://example.com/synthetic-source',
      retrievedAt,
    };
    repos.sources.saveVersion(sourceInput, lease);

    db.prepare('UPDATE source_items SET text = ? WHERE id = ?').run('Changed current legacy text.', sourceItemId);
    expect(() => db.prepare(`UPDATE research_source_versions SET body_text = 'overwritten' WHERE workspace_key = ? AND source_item_id = ?`)
      .run('workspace-a', sourceItemId)).toThrow(/immutable/);
    const evidence: ResearchEvidence = {
      kind: 'verified_excerpt',
      evidenceId: 'evidence_1',
      hypothesisId: hypothesis.hypothesisId,
      relationship: 'supports',
      source: {
        sourceId: `source_items:${sourceItemId}`,
        canonicalUrl: sourceInput.canonicalUrl,
        retrievedAt,
      },
      excerpt: {
        version: 1,
        sourceItemId,
        role: 'pain',
        quote,
        sourceTextHash: sourceHash,
        startUtf16,
        endUtf16: startUtf16 + quote.length,
      },
      verification: 'matched_to_fetched_original',
      interpretation: 'The source describes a recurring workflow.',
      independenceGroupId: `source:${sourceItemId}:${sourceHash}`,
    };
    repos.evidence.save(run.runId, evidence, lease);
    expect(repos.sources.getVersion({ sourceItemId, sourceTextHash: sourceHash, retrievedAt })?.sourceText).toBe(sourceText);
    expect(repos.evidence.list(run.runId)).toEqual([evidence]);
    expect(() => repos.sources.saveVersion({ ...sourceInput, canonicalUrl: 'https://example.com/changed' }, lease))
      .toThrow(ImmutableRecordConflictError);
    expect(() => repos.evidence.save(run.runId, { ...evidence, evidenceId: 'fabricated', excerpt: { ...evidence.excerpt, quote: 'different quote' } }, lease))
      .toThrow(/immutable fetched original/);

    const assessment: ResearchAssessment = {
      outcome: 'supported',
      summary: 'A synthetic source describes the recurring task.',
      rationale: 'One verified source is available.',
      claims: [{
        hypothesisId: hypothesis.hypothesisId,
        outcome: 'supported',
        rationale: 'The excerpt describes repeated manual work.',
        supportingEvidenceIds: ['evidence_1'],
        challengingEvidenceIds: [],
        missingEvidence: [],
      }],
      coverageGaps: [],
      nextExperiment: 'Interview a few people in the target group.',
    };
    expect(() => repos.assessments.save(run.runId, {
      ...assessment,
      claims: [{ ...assessment.claims[0], challengingEvidenceIds: ['evidence_1'] }],
    }, lease)).toThrow(/relationship does not match/);
    expect(repos.assessments.get(run.runId)).toBeNull();
    expect(repos.assessments.save(run.runId, assessment, lease)).toEqual(assessment);
    expect(repos.runs.get(run.runId)?.assessment).toEqual(assessment);
  });

  it('commits idempotent effects with receipts, replays canonical input, rejects conflicts, and rolls back failures', () => {
    const db = database();
    const { repos } = repositories(db);
    const validated = { idempotencyKey: 'same-key', intake: { ideaSummary: 'Synthetic idea' } };
    let effectCount = 0;
    const first = repos.idempotency.execute('research_case_create', 'same-key', validated, () => {
      effectCount += 1;
      return repos.cases.create({ intake: validated.intake });
    });
    const replay = repos.idempotency.execute('research_case_create', 'same-key', {
      intake: { ideaSummary: 'Synthetic idea' },
      idempotencyKey: 'same-key',
    }, () => {
      effectCount += 1;
      throw new Error('A replay must not repeat the effect');
    });
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ replayed: true, value: first.value });
    expect(effectCount).toBe(1);
    expect(() => repos.idempotency.execute('research_case_create', 'same-key', { ...validated, intake: { ideaSummary: 'Different input' } }, () => null))
      .toThrow(IdempotencyConflictError);
    expect(() => repos.idempotency.execute('research_case_create', 'promise-key', { input: 'invalid' }, () => Promise.resolve({ ok: true })))
      .toThrow(/must not return a promise/);

    const before = Number((db.prepare('SELECT COUNT(*) AS count FROM research_cases').get() as { count: number }).count);
    expect(() => repos.idempotency.execute('research_case_create', 'rollback-key', { input: 'rollback' }, () => {
      repos.cases.create({ intake: { ideaSummary: 'This insert must roll back.' } });
      throw new Error('synthetic failure');
    })).toThrow('synthetic failure');
    expect(Number((db.prepare('SELECT COUNT(*) AS count FROM research_cases').get() as { count: number }).count)).toBe(before);
    const afterRollback = repos.idempotency.execute('research_case_create', 'rollback-key', { input: 'rollback' }, () =>
      repos.cases.create({ intake: { ideaSummary: 'Retry after rollback.' } }),
    );
    expect(afterRollback.replayed).toBe(false);
  });

  it('serializes idempotent writers across SQLite connections during write contention', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-repository-lock-'));
    scratchDirectories.push(directory);
    const filename = path.join(directory, 'research.sqlite');
    const firstDb = database(filename);
    const secondDb = new Database(filename);
    databases.push(secondDb);
    secondDb.pragma('foreign_keys = ON');
    secondDb.pragma('busy_timeout = 0');
    const first = repositories(firstDb).repos;
    const second = repositories(secondDb, 'workspace-a').repos;
    firstDb.exec('BEGIN IMMEDIATE');
    try {
      expect(() => second.idempotency.execute('research_case_create', 'contended-key', { input: 'one' }, () => ({ ok: true })))
        .toThrow(/locked|busy/i);
    } finally {
      firstDb.exec('ROLLBACK');
    }
    expect(second.idempotency.execute('research_case_create', 'contended-key', { input: 'one' }, () => ({ ok: true })))
      .toEqual({ replayed: false, value: { ok: true } });
  });

  it('fences run writes and preserves a monotonically increasing epoch through release and reacquisition', () => {
    const db = database();
    const { repos, advance } = repositories(db);
    const first = createRunnableCase(repos);
    const second = createRunnableCase(repos);
    const leaseOne = repos.leases.acquire({ runId: first.run.runId, ownerInstanceId: 'worker-one', ttlMilliseconds: 100 });
    expect(() => repos.leases.acquire({ runId: second.run.runId, ownerInstanceId: 'worker-two', ttlMilliseconds: 100 }))
      .toThrow(ActiveWorkspaceLeaseError);
    repos.runs.updateRuntime(first.run.runId, { status: 'running' }, leaseOne);
    advance(101);
    const leaseTwo = repos.leases.acquire({ runId: second.run.runId, ownerInstanceId: 'worker-two', ttlMilliseconds: 100 });
    expect(leaseTwo.fencingToken).toBeGreaterThan(leaseOne.fencingToken);
    expect(() => repos.runs.updateRuntime(first.run.runId, { status: 'completed' }, leaseOne)).toThrow(StaleWorkspaceLeaseError);
    expect(repos.leases.release(leaseTwo)).toBe(true);
    const leaseThree = repos.leases.acquire({ runId: first.run.runId, ownerInstanceId: 'worker-three', ttlMilliseconds: 100 });
    expect(leaseThree.fencingToken).toBeGreaterThan(leaseTwo.fencingToken);
    expect(repos.leases.release(leaseTwo)).toBe(false);
    expect(repos.leases.release({ ...leaseThree, workspaceKey: 'workspace-other' })).toBe(false);
    expect(() => repos.leases.withWrite({ ...leaseThree, workspaceKey: 'workspace-other' }, () => true)).toThrow(StaleWorkspaceLeaseError);
    expect(() => repos.leases.withWrite(leaseThree, () => {
      db.prepare(`UPDATE research_runs SET status = 'completed' WHERE workspace_key = ? AND run_id = ?`)
        .run('workspace-a', first.run.runId);
      advance(101);
      return true;
    })).toThrow(StaleWorkspaceLeaseError);
    expect(repos.runs.get(first.run.runId)?.status).toBe('running');
  });

  it('records cancellation atomically once and never changes a terminal run back to cancelling', () => {
    const db = database();
    const { repos } = repositories(db);
    const { run } = createRunnableCase(repos);
    const lease = repos.leases.acquire({ runId: run.runId, ownerInstanceId: 'worker-cancel', ttlMilliseconds: 60_000 });
    const first = repos.runs.requestCancellation(run.runId, '2026-01-01T00:00:02.000Z');
    const repeated = repos.runs.requestCancellation(run.runId, '2026-01-01T00:00:03.000Z');
    expect(first.status).toBe('cancellation_requested');
    expect(repeated.cancelRequestedAt).toBe('2026-01-01T00:00:02.000Z');

    const completed = repos.runs.updateRuntime(run.runId, { status: 'completed', finishedAt: '2026-01-01T00:00:04.000Z' }, lease);
    const afterTerminalCancel = repos.runs.requestCancellation(run.runId, '2026-01-01T00:00:05.000Z');
    expect(afterTerminalCancel.status).toBe('completed');
    expect(afterTerminalCancel.cancelRequestedAt).toBe(completed.cancelRequestedAt);
  });
});
