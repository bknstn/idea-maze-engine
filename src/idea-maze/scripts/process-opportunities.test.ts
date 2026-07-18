import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { initSchema } from './lib/schema.ts';

const temporaryHomes: string[] = [];

function createHome(): { db: Database.Database; home: string } {
  const home = mkdtempSync(resolve(tmpdir(), 'idea-maze-process-'));
  temporaryHomes.push(home);
  mkdirSync(resolve(home, 'data'), { recursive: true });
  const db = new Database(resolve(home, 'data', 'lab.db'));
  initSchema(db);
  return { db, home };
}

afterEach(() => {
  for (const home of temporaryHomes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

describe('process-opportunities quality gate integration', () => {
  it('archives deterministic failures before research and records raw plus automation scores', () => {
    const { db, home } = createHome();
    const now = '2026-07-18T00:00:00.000Z';
    const opportunityId = Number(db.prepare(`
      INSERT INTO opportunities (
        slug, title, thesis, score, market_score, taste_adjustment, final_score,
        status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      ) VALUES (
        'oura-helper', 'Oura analysis helper', 'Oura users need recovery analysis.',
        9.8, 9.8, 0, 9.8, 'active', 'scored', 'oura-recovery', '{}', ?, ?
      )
    `).run(now, now).lastInsertRowid);
    const insertSource = db.prepare(`
      INSERT INTO source_items (
        source, external_id, title, text, timestamp_utc, ingested_at_utc,
        raw_path, content_hash
      ) VALUES ('reddit', ?, ?, ?, ?, ?, '/tmp/source.json', ?)
    `);
    const linkSource = db.prepare(`
      INSERT INTO opportunity_sources (opportunity_id, source_item_id)
      VALUES (?, ?)
    `);
    const sourceTexts = [
      'I hate manually reconciling supplier invoices every Friday.',
      'Our finance team wastes hours exporting customer payment records.',
      'I spend two hours tracking client documents in a spreadsheet.',
    ];
    sourceTexts.forEach((text, index) => {
      const sourceId = Number(insertSource.run(
        `source-${index}`,
        `Finance workflow ${index}`,
        text,
        now,
        now,
        `hash-${index}`,
      ).lastInsertRowid);
      linkSource.run(opportunityId, sourceId);
    });
    db.close();

    const result = spawnSync(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        resolve('src/idea-maze/scripts/process-opportunities.ts'),
        '--all',
      ],
      {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: '',
          IDEA_MAZE_HOME: home,
          OPENAI_API_KEY: '',
          TAVILY_API_KEY: '',
        },
      },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const verified = new Database(resolve(home, 'data', 'lab.db'));
    const opportunity = verified.prepare(
      'SELECT lifecycle_stage, status FROM opportunities WHERE id = ?',
    ).get(opportunityId);
    const researchRunCount = Number((verified.prepare(
      "SELECT COUNT(*) AS count FROM runs WHERE run_type = 'research'",
    ).get() as { count: number }).count);
    const event = verified.prepare(`
      SELECT payload_json
      FROM run_events
      WHERE event_type = 'opportunity.evidence_evaluated'
        AND opportunity_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(opportunityId) as { payload_json: string };
    verified.close();

    expect(opportunity).toEqual({ lifecycle_stage: 'archived', status: 'archived' });
    expect(researchRunCount).toBe(0);
    expect(JSON.parse(event.payload_json)).toMatchObject({
      automation_score: 7,
      deterministic_evidence: { disposition: 'needs_more_evidence' },
      final_score: 9.8,
    });
  });
});
