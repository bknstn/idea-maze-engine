import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('founder-fit scoring', () => {
  let groupDir: string;

  beforeEach(() => {
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-maze-taste-'));
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

  it('raises and lowers future ranking from publication signals without changing market score', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const {
      recomputeOpportunityScore,
      updateTasteProfileFromPublicationSignal,
    } = await import('./taste.ts');

    const db = getDb();
    initSchema(db);

    const insertOpportunity = db.prepare(`
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'shortlisted', ?, '{}', ?, ?)
    `);
    const insertRun = db.prepare(`
      INSERT INTO runs (id, run_type, target_type, target_id, status, requested_by, started_at_utc, metadata_json)
      VALUES (?, 'research', 'opportunity', ?, 'published', 'system', ?, '{}')
    `);
    const insertSource = db.prepare(`
      INSERT INTO source_items (
        id, source, external_id, text, timestamp_utc, ingested_at_utc, raw_path, content_hash, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertInsight = db.prepare(`
      INSERT INTO insights (id, source_item_id, insight_type, summary, evidence_score, confidence, status, metadata_json, created_at_utc)
      VALUES (?, ?, ?, ?, 0.8, 0.8, 'new', '{}', ?)
    `);
    const link = db.prepare(`
      INSERT INTO opportunity_sources (opportunity_id, source_item_id)
      VALUES (?, ?)
    `);

    insertOpportunity.run(
      1,
      'invoice-reconciliation-a',
      'Invoice Reconciliation A',
      'Painful invoices',
      7.5,
      7.5,
      7.5,
      'invoice-reconciliation',
      '2026-04-15T06:00:00.000Z',
      '2026-04-15T06:00:00.000Z',
    );
    insertOpportunity.run(
      2,
      'invoice-reconciliation-b',
      'Invoice Reconciliation B',
      'Still painful invoices',
      7.5,
      7.5,
      7.5,
      'invoice-reconciliation',
      '2026-04-15T06:00:00.000Z',
      '2026-04-15T06:00:00.000Z',
    );

    insertRun.run(1, '1', '2026-04-15T06:10:00.000Z');
    insertRun.run(2, '1', '2026-04-15T07:10:00.000Z');

    insertSource.run(
      1,
      'reddit',
      'reddit-1',
      'Teams keep reconciling invoices by hand.',
      '2026-04-15T06:00:00.000Z',
      '2026-04-15T06:00:00.000Z',
      '/tmp/source-1.json',
      'hash-1',
      JSON.stringify({
        harvest_signals: ['manual-work'],
        source_patterns: ['templates-and-ops'],
      }),
    );
    insertSource.run(
      2,
      'reddit',
      'reddit-2',
      'Teams still reconcile invoices by hand.',
      '2026-04-15T06:05:00.000Z',
      '2026-04-15T06:05:00.000Z',
      '/tmp/source-2.json',
      'hash-2',
      JSON.stringify({
        harvest_signals: ['manual-work'],
        source_patterns: ['templates-and-ops'],
      }),
    );
    insertInsight.run(
      1,
      1,
      'workflow_gap',
      'Manual reconciliation causes approval delays.',
      '2026-04-15T06:00:00.000Z',
    );
    insertInsight.run(
      2,
      2,
      'workflow_gap',
      'Manual reconciliation keeps the workflow stuck.',
      '2026-04-15T06:05:00.000Z',
    );
    link.run(1, 1);
    link.run(2, 2);

    updateTasteProfileFromPublicationSignal(db, {
      opportunityId: 1,
      runId: 1,
      signal: 'published',
    });
    const boosted = recomputeOpportunityScore(db, 2, 7.5);

    updateTasteProfileFromPublicationSignal(db, {
      opportunityId: 1,
      runId: 2,
      signal: 'ignored',
    });
    const reduced = recomputeOpportunityScore(db, 2, 7.5);

    expect(boosted.marketScore).toBe(7.5);
    expect(boosted.tasteAdjustment).toBeGreaterThan(0);
    expect(boosted.finalScore).toBeGreaterThan(7.5);

    expect(reduced.marketScore).toBe(7.5);
    expect(reduced.tasteAdjustment).toBeLessThan(boosted.tasteAdjustment);
    expect(reduced.finalScore).toBeLessThan(boosted.finalScore);
  });

  it('boosts opportunities that look like small self-serve subscriptions', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { computeTasteForOpportunity } = await import('./taste.ts');

    const db = getDb();
    initSchema(db);

    db.prepare(
      `
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'shortlisted', ?, '{}', ?, ?)
    `,
    ).run(
      1,
      'freelancer-inbox',
      'Freelancer Inbox',
      'Freelancers want a $29/month self-serve workflow tool they can start with a credit card.',
      7.2,
      7.2,
      7.2,
      'freelancer-inbox',
      '2026-04-15T06:00:00.000Z',
      '2026-04-15T06:00:00.000Z',
    );
    db.prepare(
      `
      INSERT INTO source_items (
        id, source, external_id, text, timestamp_utc, ingested_at_utc, raw_path, content_hash, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      1,
      'reddit',
      'reddit-1',
      "This needs to be self-serve for freelancers and small businesses. I'd pay $29 per month and buy online without booking a demo.",
      '2026-04-15T06:00:00.000Z',
      '2026-04-15T06:00:00.000Z',
      '/tmp/source-1.json',
      'hash-1',
      JSON.stringify({
        harvest_signals: ['manual-work'],
        source_patterns: ['templates-and-ops'],
      }),
    );
    db.prepare(
      `
      INSERT INTO insights (id, source_item_id, insight_type, summary, evidence_score, confidence, status, metadata_json, created_at_utc)
      VALUES (1, 1, 'willingness_to_pay', 'Freelancers would pay a small monthly subscription for a self-serve tool.', 0.9, 0.8, 'new', '{}', '2026-04-15T06:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO opportunity_sources (opportunity_id, source_item_id)
      VALUES (1, 1)
    `,
    ).run();

    const computed = computeTasteForOpportunity(db, 1, 7.2);

    expect(computed.marketScore).toBe(7.2);
    expect(computed.preferenceAdjustment).toBeGreaterThan(0);
    expect(computed.tasteAdjustment).toBeGreaterThan(0);
    expect(computed.finalScore).toBeGreaterThan(7.2);
    expect(computed.preferenceSignals.map((signal) => signal.signal)).toContain(
      'low_ticket_subscription',
    );
  });

  it('penalizes enterprise-heavy opportunities before they reach artifact publication', async () => {
    const { getDb } = await import('./db.ts');
    const { initSchema } = await import('./schema.ts');
    const { computeTasteForOpportunity } = await import('./taste.ts');

    const db = getDb();
    initSchema(db);

    db.prepare(
      `
      INSERT INTO opportunities (
        id, slug, title, thesis, score, market_score, final_score, status, lifecycle_stage, cluster_key, metadata_json, created_at_utc, updated_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'shortlisted', ?, '{}', ?, ?)
    `,
    ).run(
      1,
      'enterprise-governance',
      'Enterprise Governance',
      'This likely needs SSO, procurement approval, and a sales-led rollout.',
      7.8,
      7.8,
      7.8,
      'enterprise-governance',
      '2026-04-15T06:00:00.000Z',
      '2026-04-15T06:00:00.000Z',
    );
    db.prepare(
      `
      INSERT INTO source_items (
        id, source, external_id, text, timestamp_utc, ingested_at_utc, raw_path, content_hash, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      1,
      'reddit',
      'reddit-1',
      'Buyers expect enterprise security review, SOC 2, SAML, customer success, professional services, and a book-a-demo flow with annual contracts.',
      '2026-04-15T06:00:00.000Z',
      '2026-04-15T06:00:00.000Z',
      '/tmp/source-1.json',
      'hash-1',
      JSON.stringify({
        harvest_signals: ['workflow-context'],
        source_patterns: ['support-workflow'],
      }),
    );
    db.prepare(
      `
      INSERT INTO insights (id, source_item_id, insight_type, summary, evidence_score, confidence, status, metadata_json, created_at_utc)
      VALUES (1, 1, 'implementation_constraint', 'The opportunity depends on enterprise rollout requirements.', 0.9, 0.8, 'new', '{}', '2026-04-15T06:00:00.000Z')
    `,
    ).run();
    db.prepare(
      `
      INSERT INTO opportunity_sources (opportunity_id, source_item_id)
      VALUES (1, 1)
    `,
    ).run();

    const computed = computeTasteForOpportunity(db, 1, 7.8);

    expect(computed.marketScore).toBe(7.8);
    expect(computed.preferenceAdjustment).toBeLessThan(0);
    expect(computed.tasteAdjustment).toBeLessThan(0);
    expect(computed.finalScore).toBeLessThan(7.8);
    expect(computed.preferenceSignals.map((signal) => signal.signal)).toContain(
      'enterprise_sales_motion',
    );
  });
});
