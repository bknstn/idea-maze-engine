import type Database from 'better-sqlite3';

import { AUTO_PUBLISH_MIN_BUCKET } from './opportunity-policy.ts';

/**
 * Initialize the full Idea Maze schema. Safe to call multiple times —
 * all statements use IF NOT EXISTS.
 */
export function initSchema(db: Database.Database): void {
  db.exec(`
    -- Core tables

    CREATE TABLE IF NOT EXISTS source_items (
      id              INTEGER PRIMARY KEY,
      source          TEXT    NOT NULL,
      external_id     TEXT    NOT NULL,
      thread_ref      TEXT,
      author          TEXT,
      title           TEXT,
      text            TEXT    NOT NULL,
      canonical_url   TEXT,
      channel_or_label TEXT,
      timestamp_utc   TEXT    NOT NULL,
      ingested_at_utc TEXT    NOT NULL,
      raw_path        TEXT    NOT NULL,
      content_hash    TEXT    NOT NULL,
      sensitivity     TEXT    NOT NULL DEFAULT 'normal',
      metadata_json   TEXT    NOT NULL DEFAULT '{}',
      UNIQUE(source, external_id)
    );

    CREATE INDEX IF NOT EXISTS ix_source_items_source          ON source_items(source);
    CREATE INDEX IF NOT EXISTS ix_source_items_external_id     ON source_items(external_id);
    CREATE INDEX IF NOT EXISTS ix_source_items_thread_ref      ON source_items(thread_ref);
    CREATE INDEX IF NOT EXISTS ix_source_items_channel_or_label ON source_items(channel_or_label);
    CREATE INDEX IF NOT EXISTS ix_source_items_timestamp_utc   ON source_items(timestamp_utc);
    CREATE INDEX IF NOT EXISTS ix_source_items_ingested_at_utc ON source_items(ingested_at_utc);
    CREATE INDEX IF NOT EXISTS ix_source_items_content_hash    ON source_items(content_hash);

    CREATE TABLE IF NOT EXISTS insights (
      id              INTEGER PRIMARY KEY,
      source_item_id  INTEGER NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
      insight_type    TEXT    NOT NULL,
      summary         TEXT    NOT NULL,
      evidence_score  REAL    NOT NULL DEFAULT 0,
      confidence      REAL    NOT NULL DEFAULT 0,
      status          TEXT    NOT NULL DEFAULT 'new',
      metadata_json   TEXT    NOT NULL DEFAULT '{}',
      created_at_utc  TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ix_insights_source_item_id ON insights(source_item_id);
    CREATE INDEX IF NOT EXISTS ix_insights_insight_type   ON insights(insight_type);
    CREATE INDEX IF NOT EXISTS ix_insights_status         ON insights(status);
    CREATE INDEX IF NOT EXISTS ix_insights_created_at_utc ON insights(created_at_utc);

    CREATE TABLE IF NOT EXISTS opportunities (
      id                  INTEGER PRIMARY KEY,
      slug                TEXT    NOT NULL UNIQUE,
      title               TEXT    NOT NULL,
      thesis              TEXT    NOT NULL,
      score               REAL    NOT NULL DEFAULT 0,
      market_score        REAL    NOT NULL DEFAULT 0,
      taste_adjustment    REAL    NOT NULL DEFAULT 0,
      final_score         REAL    NOT NULL DEFAULT 0,
      status              TEXT    NOT NULL DEFAULT 'active',
      lifecycle_stage     TEXT    NOT NULL DEFAULT 'scored',
      cluster_key         TEXT    NOT NULL,
      metadata_json       TEXT    NOT NULL DEFAULT '{}',
      created_at_utc      TEXT    NOT NULL,
      updated_at_utc      TEXT    NOT NULL,
      last_reviewed_at_utc TEXT
    );

    CREATE INDEX IF NOT EXISTS ix_opportunities_slug           ON opportunities(slug);
    CREATE INDEX IF NOT EXISTS ix_opportunities_score          ON opportunities(score);
    CREATE INDEX IF NOT EXISTS ix_opportunities_status         ON opportunities(status);
    CREATE INDEX IF NOT EXISTS ix_opportunities_cluster_key    ON opportunities(cluster_key);
    CREATE INDEX IF NOT EXISTS ix_opportunities_created_at_utc ON opportunities(created_at_utc);
    CREATE INDEX IF NOT EXISTS ix_opportunities_updated_at_utc ON opportunities(updated_at_utc);

    CREATE TABLE IF NOT EXISTS opportunity_sources (
      id              INTEGER PRIMARY KEY,
      opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      source_item_id  INTEGER NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
      UNIQUE(opportunity_id, source_item_id)
    );

    CREATE INDEX IF NOT EXISTS ix_opportunity_sources_opportunity_id ON opportunity_sources(opportunity_id);
    CREATE INDEX IF NOT EXISTS ix_opportunity_sources_source_item_id ON opportunity_sources(source_item_id);

    CREATE TABLE IF NOT EXISTS runs (
      id              INTEGER PRIMARY KEY,
      run_type        TEXT    NOT NULL,
      target_type     TEXT,
      target_id       TEXT,
      status          TEXT    NOT NULL DEFAULT 'queued',
      requested_by    TEXT    NOT NULL DEFAULT 'system',
      started_at_utc  TEXT    NOT NULL,
      completed_at_utc TEXT,
      error           TEXT,
      metadata_json   TEXT    NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS ix_runs_run_type       ON runs(run_type);
    CREATE INDEX IF NOT EXISTS ix_runs_target_type    ON runs(target_type);
    CREATE INDEX IF NOT EXISTS ix_runs_target_id      ON runs(target_id);
    CREATE INDEX IF NOT EXISTS ix_runs_status         ON runs(status);
    CREATE INDEX IF NOT EXISTS ix_runs_started_at_utc ON runs(started_at_utc);

    CREATE TABLE IF NOT EXISTS artifacts (
      id              INTEGER PRIMARY KEY,
      opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      run_id          INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      path            TEXT    NOT NULL,
      version         INTEGER NOT NULL DEFAULT 1,
      approved_at_utc TEXT,
      created_at_utc  TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ix_artifacts_opportunity_id ON artifacts(opportunity_id);
    CREATE INDEX IF NOT EXISTS ix_artifacts_run_id         ON artifacts(run_id);
    CREATE INDEX IF NOT EXISTS ix_artifacts_created_at_utc ON artifacts(created_at_utc);

    CREATE TABLE IF NOT EXISTS artifact_exports (
      id                  INTEGER PRIMARY KEY,
      artifact_id         INTEGER NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE CASCADE,
      status              TEXT    NOT NULL DEFAULT 'pending',
      relative_path       TEXT    NOT NULL,
      repo_url            TEXT,
      repo_branch         TEXT,
      attempt_count       INTEGER NOT NULL DEFAULT 0,
      last_attempt_at_utc TEXT,
      commit_sha          TEXT,
      last_error          TEXT,
      created_at_utc      TEXT    NOT NULL,
      updated_at_utc      TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ix_artifact_exports_status              ON artifact_exports(status);
    CREATE INDEX IF NOT EXISTS ix_artifact_exports_updated_at_utc      ON artifact_exports(updated_at_utc);
    CREATE INDEX IF NOT EXISTS ix_artifact_exports_last_attempt_at_utc ON artifact_exports(last_attempt_at_utc);

    CREATE TABLE IF NOT EXISTS approvals (
      id              INTEGER PRIMARY KEY,
      run_id          INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      decision        TEXT    NOT NULL,
      notes           TEXT,
      decided_at_utc  TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ix_approvals_run_id         ON approvals(run_id);
    CREATE INDEX IF NOT EXISTS ix_approvals_decision       ON approvals(decision);
    CREATE INDEX IF NOT EXISTS ix_approvals_decided_at_utc ON approvals(decided_at_utc);

    CREATE TABLE IF NOT EXISTS app_state (
      key             TEXT PRIMARY KEY,
      value_json      TEXT    NOT NULL DEFAULT '{}',
      updated_at_utc  TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ix_app_state_updated_at_utc ON app_state(updated_at_utc);

    CREATE TABLE IF NOT EXISTS run_events (
      id              INTEGER PRIMARY KEY,
      run_id          INTEGER REFERENCES runs(id) ON DELETE CASCADE,
      opportunity_id  INTEGER REFERENCES opportunities(id) ON DELETE CASCADE,
      event_type      TEXT    NOT NULL,
      stage           TEXT,
      actor           TEXT    NOT NULL DEFAULT 'system',
      status          TEXT    NOT NULL DEFAULT 'info',
      summary         TEXT    NOT NULL,
      payload_json    TEXT    NOT NULL DEFAULT '{}',
      created_at_utc  TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS ix_run_events_run_id         ON run_events(run_id);
    CREATE INDEX IF NOT EXISTS ix_run_events_opportunity_id ON run_events(opportunity_id);
    CREATE INDEX IF NOT EXISTS ix_run_events_stage          ON run_events(stage);
    CREATE INDEX IF NOT EXISTS ix_run_events_status         ON run_events(status);
    CREATE INDEX IF NOT EXISTS ix_run_events_created_at_utc ON run_events(created_at_utc);

    CREATE TABLE IF NOT EXISTS feedback_features (
      id              INTEGER PRIMARY KEY,
      run_id          INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      opportunity_id  INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
      decision        TEXT    NOT NULL,
      feature_type    TEXT    NOT NULL,
      feature_value   TEXT    NOT NULL,
      created_at_utc  TEXT    NOT NULL,
      UNIQUE(run_id, feature_type, feature_value)
    );

    CREATE INDEX IF NOT EXISTS ix_feedback_features_run_id         ON feedback_features(run_id);
    CREATE INDEX IF NOT EXISTS ix_feedback_features_opportunity_id ON feedback_features(opportunity_id);
    CREATE INDEX IF NOT EXISTS ix_feedback_features_type_value     ON feedback_features(feature_type, feature_value);

    CREATE TABLE IF NOT EXISTS taste_profile (
      id              INTEGER PRIMARY KEY,
      feature_type    TEXT    NOT NULL,
      feature_value   TEXT    NOT NULL,
      approved_count  INTEGER NOT NULL DEFAULT 0,
      rejected_count  INTEGER NOT NULL DEFAULT 0,
      learned_weight  REAL    NOT NULL DEFAULT 0,
      updated_at_utc  TEXT    NOT NULL,
      UNIQUE(feature_type, feature_value)
    );

    CREATE INDEX IF NOT EXISTS ix_taste_profile_type_value ON taste_profile(feature_type, feature_value);
    CREATE INDEX IF NOT EXISTS ix_taste_profile_updated_at ON taste_profile(updated_at_utc);
  `);

  ensureCompatibilityColumns(db);
  ensureCompatibilityIndexes(db);
  backfillOpportunityState(db);

  // FTS5 tables — CREATE VIRTUAL TABLE doesn't support IF NOT EXISTS,
  // so we check for existence first.
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('source_items_fts','insights_fts','opportunities_fts')",
    )
    .all()
    .map((r: any) => r.name);

  if (!tables.includes('source_items_fts')) {
    db.exec(`
      CREATE VIRTUAL TABLE source_items_fts USING fts5(
        title, text,
        content='source_items',
        content_rowid='id'
      );
    `);
  }

  if (!tables.includes('insights_fts')) {
    db.exec(`
      CREATE VIRTUAL TABLE insights_fts USING fts5(
        summary,
        content='insights',
        content_rowid='id'
      );
    `);
  }

  if (!tables.includes('opportunities_fts')) {
    db.exec(`
      CREATE VIRTUAL TABLE opportunities_fts USING fts5(
        title, thesis,
        content='opportunities',
        content_rowid='id'
      );
    `);
  }

  // FTS sync triggers — drop + recreate to ensure they match current schema
  db.exec(`
    DROP TRIGGER IF EXISTS source_items_ai;
    CREATE TRIGGER source_items_ai AFTER INSERT ON source_items BEGIN
      INSERT INTO source_items_fts(rowid, title, text)
        VALUES (new.id, coalesce(new.title, ''), new.text);
    END;

    DROP TRIGGER IF EXISTS source_items_ad;
    CREATE TRIGGER source_items_ad AFTER DELETE ON source_items BEGIN
      INSERT INTO source_items_fts(source_items_fts, rowid, title, text)
        VALUES ('delete', old.id, coalesce(old.title, ''), old.text);
    END;

    DROP TRIGGER IF EXISTS source_items_au;
    CREATE TRIGGER source_items_au AFTER UPDATE ON source_items BEGIN
      INSERT INTO source_items_fts(source_items_fts, rowid, title, text)
        VALUES ('delete', old.id, coalesce(old.title, ''), old.text);
      INSERT INTO source_items_fts(rowid, title, text)
        VALUES (new.id, coalesce(new.title, ''), new.text);
    END;

    DROP TRIGGER IF EXISTS insights_ai;
    CREATE TRIGGER insights_ai AFTER INSERT ON insights BEGIN
      INSERT INTO insights_fts(rowid, summary)
        VALUES (new.id, new.summary);
    END;

    DROP TRIGGER IF EXISTS insights_ad;
    CREATE TRIGGER insights_ad AFTER DELETE ON insights BEGIN
      INSERT INTO insights_fts(insights_fts, rowid, summary)
        VALUES ('delete', old.id, old.summary);
    END;

    DROP TRIGGER IF EXISTS insights_au;
    CREATE TRIGGER insights_au AFTER UPDATE ON insights BEGIN
      INSERT INTO insights_fts(insights_fts, rowid, summary)
        VALUES ('delete', old.id, old.summary);
      INSERT INTO insights_fts(rowid, summary)
        VALUES (new.id, new.summary);
    END;

    DROP TRIGGER IF EXISTS opportunities_ai;
    CREATE TRIGGER opportunities_ai AFTER INSERT ON opportunities BEGIN
      INSERT INTO opportunities_fts(rowid, title, thesis)
        VALUES (new.id, new.title, new.thesis);
    END;

    DROP TRIGGER IF EXISTS opportunities_ad;
    CREATE TRIGGER opportunities_ad AFTER DELETE ON opportunities BEGIN
      INSERT INTO opportunities_fts(opportunities_fts, rowid, title, thesis)
        VALUES ('delete', old.id, old.title, old.thesis);
    END;

    DROP TRIGGER IF EXISTS opportunities_au;
    CREATE TRIGGER opportunities_au AFTER UPDATE ON opportunities BEGIN
      INSERT INTO opportunities_fts(opportunities_fts, rowid, title, thesis)
        VALUES ('delete', old.id, old.title, old.thesis);
      INSERT INTO opportunities_fts(rowid, title, thesis)
        VALUES (new.id, new.title, new.thesis);
    END;
  `);
}

function getColumnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = getColumnNames(db, table);
  if (!columns.has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureCompatibilityColumns(db: Database.Database): void {
  addColumnIfMissing(
    db,
    'opportunities',
    'market_score',
    'REAL NOT NULL DEFAULT 0',
  );
  addColumnIfMissing(
    db,
    'opportunities',
    'taste_adjustment',
    'REAL NOT NULL DEFAULT 0',
  );
  addColumnIfMissing(
    db,
    'opportunities',
    'final_score',
    'REAL NOT NULL DEFAULT 0',
  );
  addColumnIfMissing(
    db,
    'opportunities',
    'lifecycle_stage',
    "TEXT NOT NULL DEFAULT 'scored'",
  );
}

function ensureCompatibilityIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS ix_opportunities_market_score    ON opportunities(market_score);
    CREATE INDEX IF NOT EXISTS ix_opportunities_final_score     ON opportunities(final_score);
    CREATE INDEX IF NOT EXISTS ix_opportunities_lifecycle_stage ON opportunities(lifecycle_stage);
  `);
}

function backfillOpportunityState(db: Database.Database): void {
  db.exec(`
    UPDATE opportunities
    SET market_score = CASE
          WHEN market_score = 0 THEN score
          ELSE market_score
        END,
        final_score = CASE
          WHEN final_score = 0 THEN score
          ELSE final_score
        END,
        score = CASE
          WHEN final_score != 0 THEN final_score
          ELSE score
        END
  `);

  db.exec(`
    UPDATE opportunities
    SET lifecycle_stage = CASE
	      WHEN EXISTS (
	        SELECT 1 FROM artifacts a
	        WHERE a.opportunity_id = opportunities.id
	      ) THEN 'artifact'
	      WHEN EXISTS (
	        SELECT 1 FROM runs r
	        WHERE r.target_id = CAST(opportunities.id AS TEXT)
	          AND r.status IN ('draft_ready', 'review_gate')
	      ) THEN 'researching'
      WHEN EXISTS (
        SELECT 1 FROM runs r
        WHERE r.target_id = CAST(opportunities.id AS TEXT)
          AND r.status = 'running'
      ) THEN 'researching'
      WHEN EXISTS (
        SELECT 1 FROM runs r
        WHERE r.target_id = CAST(opportunities.id AS TEXT)
	          AND r.status = 'rejected'
	      ) THEN 'archived'
      WHEN status = 'archived' THEN 'archived'
      WHEN final_score >= ${AUTO_PUBLISH_MIN_BUCKET} THEN 'shortlisted'
      ELSE 'scored'
    END
    WHERE lifecycle_stage IS NULL
       OR lifecycle_stage = ''
       OR lifecycle_stage = 'scored'
  `);

  db.exec(`
    UPDATE opportunities
    SET lifecycle_stage = 'archived'
    WHERE status = 'archived'
	      AND lifecycle_stage NOT IN ('artifact', 'researching')
	  `);

  db.exec(`
    UPDATE opportunities
    SET lifecycle_stage = 'artifact'
    WHERE lifecycle_stage = 'approved'
       OR EXISTS (
         SELECT 1 FROM artifacts a
         WHERE a.opportunity_id = opportunities.id
       )
  `);

  db.exec(`
    UPDATE opportunities
    SET lifecycle_stage = 'researching'
    WHERE lifecycle_stage = 'review_gate'
  `);

  db.exec(`
    UPDATE opportunities
    SET lifecycle_stage = 'archived',
        status = 'archived'
    WHERE lifecycle_stage = 'rejected'
  `);
}
