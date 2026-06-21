import { getDb } from './lib/db.ts';
import { getOption, hasFlag, writeJson } from './lib/cli.ts';
import { initSchema } from './lib/schema.ts';

interface ExplorationRow {
  id: number;
  opportunity_slug: string;
  opportunity_title: string;
  run_id: number;
  path: string;
  created_at_utc: string;
  next_action: string | null;
  brief_json: string;
}

function parseLimit(): number {
  const raw = Number(getOption('--limit') ?? 20);
  if (!Number.isFinite(raw)) return 20;
  return Math.max(1, Math.min(100, Math.floor(raw)));
}

function main() {
  const db = getDb();
  initSchema(db);
  const rows = db.prepare(`
    SELECT
      e.id,
      o.slug AS opportunity_slug,
      o.title AS opportunity_title,
      e.run_id,
      e.path,
      e.created_at_utc,
      e.brief_json
    FROM exploration_artifacts e
    JOIN opportunities o ON o.id = e.opportunity_id
    ORDER BY e.created_at_utc DESC, e.id DESC
    LIMIT ?
  `).all(parseLimit()) as ExplorationRow[];
  const result = rows.map((row) => {
    let nextAction: string | null = null;
    try {
      nextAction = JSON.parse(row.brief_json).next_action ?? null;
    } catch {
      nextAction = null;
    }
    return {
      id: row.id,
      opportunity_slug: row.opportunity_slug,
      opportunity_title: row.opportunity_title,
      run_id: row.run_id,
      path: row.path,
      created_at_utc: row.created_at_utc,
      next_action: nextAction,
    };
  });
  if (hasFlag('--json')) writeJson(result);
  else {
    if (!result.length) console.log('No exploration briefs.');
    for (const row of result) {
      console.log(`${row.created_at_utc}: ${row.opportunity_slug} run #${row.run_id} — ${row.path}`);
      if (row.next_action) console.log(`  Next: ${row.next_action}`);
    }
  }
}

main();
