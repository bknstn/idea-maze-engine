import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("refresh-opportunities", () => {
  let ideaMazeHome: string;

  beforeEach(() => {
    ideaMazeHome = fs.mkdtempSync(path.join(os.tmpdir(), "idea-maze-refresh-"));
    fs.mkdirSync(path.join(ideaMazeHome, "data"), { recursive: true });
    process.env.IDEA_MAZE_HOME = ideaMazeHome;
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import("./lib/db.ts");
    closeDb();
    delete process.env.IDEA_MAZE_HOME;
    fs.rmSync(ideaMazeHome, { recursive: true, force: true });
  });

  it("archives low-score clusters instead of dropping them entirely", async () => {
    const { getDb } = await import("./lib/db.ts");
    const { initSchema } = await import("./lib/schema.ts");

    const db = getDb();
    initSchema(db);

    const insertSource = db.prepare(`
      INSERT INTO source_items (
        id, source, external_id, title, text, timestamp_utc, ingested_at_utc, raw_path, content_hash, metadata_json
      )
      VALUES (?, 'reddit', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertInsight = db.prepare(`
      INSERT INTO insights (source_item_id, insight_type, summary, evidence_score, confidence, status, metadata_json, created_at_utc)
      VALUES (?, 'pain_point', ?, 0.1, 0.5, 'new', '{}', ?)
    `);

    for (let index = 1; index <= 3; index++) {
      insertSource.run(
        index,
        `reddit-${index}`,
        "Invoice reconciliation help",
        "I keep reconciling invoices manually.",
        `2026-04-15T06:0${index}:00.000Z`,
        `2026-04-15T06:0${index}:00.000Z`,
        `/tmp/source-${index}.json`,
        `hash-${index}`,
        JSON.stringify({ harvest_signals: [], source_patterns: [] }),
      );
      insertInsight.run(
        index,
        "Manual invoice reconciliation keeps showing up.",
        `2026-04-15T06:0${index}:00.000Z`,
      );
    }

    await import("./refresh-opportunities.ts");

    const refreshedDb = getDb();
    const opportunity = refreshedDb.prepare(`
      SELECT status, lifecycle_stage
      FROM opportunities
      LIMIT 1
    `).get() as { lifecycle_stage: string; status: string } | undefined;

    expect(opportunity).toBeDefined();
    expect(opportunity?.status).toBe("archived");
    expect(opportunity?.lifecycle_stage).toBe("archived");
  });

  it("strips html/url noise before deriving cluster labels", async () => {
    const { getDb } = await import("./lib/db.ts");
    const { initSchema } = await import("./lib/schema.ts");

    const db = getDb();
    initSchema(db);

    const insertSource = db.prepare(`
      INSERT INTO source_items (
        id, source, external_id, title, text, timestamp_utc, ingested_at_utc, raw_path, content_hash, metadata_json
      )
      VALUES (?, 'reddit', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertInsight = db.prepare(`
      INSERT INTO insights (source_item_id, insight_type, summary, evidence_score, confidence, status, metadata_json, created_at_utc)
      VALUES (?, 'pain_point', ?, 0.8, 0.8, 'new', '{}', ?)
    `);

    for (let index = 1; index <= 3; index++) {
      insertSource.run(
        index,
        `reddit-html-${index}`,
        '<strong><a href="https://reddit.com/comments/abc">Invoice reconciliation</a></strong>',
        '<span class="md"><pre><code>Manual invoice reconciliation is still painful for finance ops teams.</code></pre></span>',
        `2026-04-15T07:0${index}:00.000Z`,
        `2026-04-15T07:0${index}:00.000Z`,
        `/tmp/source-html-${index}.json`,
        `hash-html-${index}`,
        JSON.stringify({ harvest_score: 0.8, harvest_signals: [], source_patterns: [] }),
      );
      insertInsight.run(
        index,
        "Manual invoice reconciliation keeps causing finance ops pain.",
        `2026-04-15T07:0${index}:00.000Z`,
      );
    }

    await import("./refresh-opportunities.ts");

    const rows = getDb()
      .prepare('SELECT slug FROM opportunities ORDER BY slug')
      .all() as { slug: string }[];

    expect(rows.map((row) => row.slug)).toContain("invoice-reconciliation");
    expect(rows.map((row) => row.slug)).not.toContain("strong-href");
  });


  it("keeps human review lifecycle decisions sticky during refresh", async () => {
    const { getDb } = await import("./lib/db.ts");
    const { initSchema } = await import("./lib/schema.ts");

    const db = getDb();
    initSchema(db);

    db.prepare(`
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES (1, 'invoice-reconciliation', 'Invoice Reconciliation', 'Old thesis', 10, 10, 10, 'archived', 'rejected', 'invoice', '{}', '2026-04-14T06:00:00.000Z', '2026-04-14T06:00:00.000Z')
    `).run();

    const insertSource = db.prepare(`
      INSERT INTO source_items (
        id, source, external_id, title, text, timestamp_utc, ingested_at_utc, raw_path, content_hash, metadata_json
      )
      VALUES (?, 'reddit', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertInsight = db.prepare(`
      INSERT INTO insights (source_item_id, insight_type, summary, evidence_score, confidence, status, metadata_json, created_at_utc)
      VALUES (?, 'pain_point', ?, 0.9, 0.9, 'new', '{}', ?)
    `);

    for (let index = 1; index <= 3; index++) {
      insertSource.run(
        index,
        `reddit-sticky-${index}`,
        "Invoice reconciliation help",
        "Finance teams keep reconciling invoices manually.",
        `2026-04-15T08:0${index}:00.000Z`,
        `2026-04-15T08:0${index}:00.000Z`,
        `/tmp/source-sticky-${index}.json`,
        `hash-sticky-${index}`,
        JSON.stringify({ harvest_score: 1.0, harvest_signals: [], source_patterns: [] }),
      );
      insertInsight.run(
        index,
        "Manual invoice reconciliation keeps showing up.",
        `2026-04-15T08:0${index}:00.000Z`,
      );
    }

    await import("./refresh-opportunities.ts");

    const opportunity = getDb()
      .prepare('SELECT status, lifecycle_stage FROM opportunities WHERE slug = ?')
      .get('invoice-reconciliation') as { lifecycle_stage: string; status: string };

    expect(opportunity.status).toBe("archived");
    expect(opportunity.lifecycle_stage).toBe("rejected");
  });

});
