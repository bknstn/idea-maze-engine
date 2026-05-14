import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('initSchema migrations', () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-schema-'));
    fs.mkdirSync(path.join(groupDir, 'data'), { recursive: true });
    process.env.WORKSPACE_GROUP = groupDir;
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import('./db.ts');
    closeDb();
    delete process.env.WORKSPACE_GROUP;
    fs.rmSync(groupDir, { recursive: true, force: true });
  });

  it('adds new opportunity columns and backfills lifecycle/score state on old databases', async () => {
    const dbPath = path.join(groupDir, 'data', 'lab.db');
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE opportunities (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        thesis TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        cluster_key TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        last_reviewed_at_utc TEXT
      );
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY,
        run_type TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        requested_by TEXT NOT NULL DEFAULT 'system',
        started_at_utc TEXT NOT NULL,
        completed_at_utc TEXT,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE artifacts (
        id INTEGER PRIMARY KEY,
        opportunity_id INTEGER NOT NULL,
        run_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        approved_at_utc TEXT,
        created_at_utc TEXT NOT NULL
      );
    `);
    rawDb
      .prepare(
        `
      INSERT INTO opportunities (id, slug, title, thesis, score, status, cluster_key, metadata_json, created_at_utc, updated_at_utc)
      VALUES (1, 'finance-ops', 'Finance Ops', 'Manual invoices are painful.', 8.4, 'active', 'finance-ops', '{}', '2026-04-15T06:00:00.000Z', '2026-04-15T06:00:00.000Z')
    `,
      )
      .run();
    rawDb
      .prepare(
        `
      INSERT INTO opportunities (id, slug, title, thesis, score, status, cluster_key, metadata_json, created_at_utc, updated_at_utc)
      VALUES (2, 'solo-crm', 'Solo CRM', 'Solo operators need lightweight CRM follow-up.', 8.4, 'active', 'solo-crm', '{}', '2026-04-15T06:00:00.000Z', '2026-04-15T06:00:00.000Z')
    `,
      )
      .run();
    rawDb
      .prepare(
        `
      INSERT INTO opportunities (id, slug, title, thesis, score, status, cluster_key, metadata_json, created_at_utc, updated_at_utc)
      VALUES (3, 'receipt-agent', 'Receipt Agent', 'Tiny teams need receipt cleanup automation.', 9.1, 'active', 'receipt-agent', '{}', '2026-04-15T06:00:00.000Z', '2026-04-15T06:00:00.000Z')
    `,
      )
      .run();
    rawDb
      .prepare(
        `
      INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES (1, 'research', 'opportunity', '1', 'review_gate', 'system', '2026-04-15T06:10:00.000Z', '{}')
    `,
      )
      .run();
    rawDb.close();

    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');

    const db = getDb();
    initSchema(db);

    const columns = db
      .prepare('PRAGMA table_info(opportunities)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('market_score');
    expect(columns.map((column) => column.name)).toContain('taste_adjustment');
    expect(columns.map((column) => column.name)).toContain('final_score');
    expect(columns.map((column) => column.name)).toContain('lifecycle_stage');
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_exports'",
      )
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);

    const row = db
      .prepare(
        `
      SELECT market_score, final_score, lifecycle_stage
      FROM opportunities
      WHERE id = 1
    `,
      )
      .get() as {
      final_score: number;
      lifecycle_stage: string;
      market_score: number;
    };

    expect(row.market_score).toBe(8.4);
    expect(row.final_score).toBe(8.4);
    expect(row.lifecycle_stage).toBe('researching');

    const backfilledRows = db
      .prepare(
        `
      SELECT id, lifecycle_stage
      FROM opportunities
      WHERE id IN (2, 3)
      ORDER BY id
    `,
      )
      .all() as Array<{ id: number; lifecycle_stage: string }>;

    expect(backfilledRows).toEqual([
      { id: 2, lifecycle_stage: 'scored' },
      { id: 3, lifecycle_stage: 'shortlisted' },
    ]);
  });
});
