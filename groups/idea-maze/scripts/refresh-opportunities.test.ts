import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("refresh-opportunities", () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-maze-refresh-"));
    fs.mkdirSync(path.join(groupDir, "data"), { recursive: true });
    process.env.WORKSPACE_GROUP = groupDir;
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import("./lib/db.ts");
    closeDb();
    delete process.env.WORKSPACE_GROUP;
    fs.rmSync(groupDir, { recursive: true, force: true });
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
});
