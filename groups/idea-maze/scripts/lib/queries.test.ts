import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getCounts', () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-queries-'));
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

  it('counts running and draft-ready research as unfinished work', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { getCounts } = await import('./queries.ts');

    const db = getDb();
    initSchema(db);

    db.prepare(
      `
      INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'research',
      'opportunity',
      '1',
      'draft_ready',
      'system',
      '2026-04-15T06:00:00.000Z',
      '{}',
    );
    db.prepare(
      `
      INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'research',
      'opportunity',
      '2',
      'running',
      'system',
      '2026-04-15T06:01:00.000Z',
      '{}',
    );
    db.prepare(
      `
      INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, completed_at_utc, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'research',
      'opportunity',
      '3',
      'published',
      'system',
      '2026-04-15T06:02:00.000Z',
      '2026-04-15T06:03:00.000Z',
      '{}',
    );
    db.prepare(
      `
      INSERT INTO runs (run_type, target_type, target_id, status, requested_by, started_at_utc, completed_at_utc, error, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'research',
      'opportunity',
      '4',
      'error',
      'system',
      '2026-04-15T06:04:00.000Z',
      '2026-04-15T06:05:00.000Z',
      'boom',
      '{}',
    );

    expect(getCounts().runs_pending).toBe(2);
  });
});
