import type Database from 'better-sqlite3';

/**
 * Additive schema for hypothesis research. The legacy discovery tables are not
 * altered; research data is kept in its own workspace-scoped tables.
 */
export function migrateResearchSchema(db: Database.Database): void {
  // SQLite only changes this pragma outside a transaction.
  db.pragma('foreign_keys = ON');
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('Research migrations require SQLite foreign-key enforcement');
  }

  const apply = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_utc TEXT NOT NULL
      );
    `);

    const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM research_schema_migrations').get() as { version: number };
    if (current.version >= 1) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS research_hypothesis_suggestions (
        workspace_key TEXT NOT NULL,
        suggestion_id TEXT NOT NULL,
        claim TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (workspace_key, suggestion_id)
      );

      CREATE TABLE IF NOT EXISTS research_cases (
        workspace_key TEXT NOT NULL,
        case_id TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
        created_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        PRIMARY KEY (workspace_key, case_id)
      );

      CREATE TABLE IF NOT EXISTS research_case_revisions (
        workspace_key TEXT NOT NULL,
        case_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        intake_json TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (workspace_key, case_id, revision),
        FOREIGN KEY (workspace_key, case_id)
          REFERENCES research_cases(workspace_key, case_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_hypotheses (
        workspace_key TEXT NOT NULL,
        case_id TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (workspace_key, case_id, hypothesis_id),
        UNIQUE (workspace_key, hypothesis_id),
        FOREIGN KEY (workspace_key, case_id)
          REFERENCES research_cases(workspace_key, case_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_hypothesis_revisions (
        workspace_key TEXT NOT NULL,
        case_id TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        claim TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('user_supplied', 'model_suggested')),
        source_suggestion_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (workspace_key, case_id, hypothesis_id, revision),
        FOREIGN KEY (workspace_key, case_id, hypothesis_id)
          REFERENCES research_hypotheses(workspace_key, case_id, hypothesis_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, source_suggestion_id)
          REFERENCES research_hypothesis_suggestions(workspace_key, suggestion_id) ON DELETE RESTRICT,
        CHECK ((origin = 'user_supplied' AND source_suggestion_id IS NULL)
          OR (origin = 'model_suggested' AND source_suggestion_id IS NOT NULL))
      );

      CREATE TABLE IF NOT EXISTS research_plans (
        workspace_key TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        case_revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (workspace_key, plan_id),
        UNIQUE (workspace_key, plan_id, case_id, case_revision),
        FOREIGN KEY (workspace_key, case_id, case_revision)
          REFERENCES research_case_revisions(workspace_key, case_id, revision) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_plan_queries (
        workspace_key TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        case_revision INTEGER NOT NULL,
        query_id TEXT NOT NULL,
        query_text TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('problem_language', 'workaround', 'alternative', 'counterevidence')),
        evidence_intent TEXT NOT NULL CHECK (evidence_intent IN ('supporting', 'challenging', 'context')),
        source_scopes_json TEXT NOT NULL,
        PRIMARY KEY (workspace_key, plan_id, query_id),
        UNIQUE (workspace_key, plan_id, query_id, case_id),
        FOREIGN KEY (workspace_key, plan_id, case_id, case_revision)
          REFERENCES research_plans(workspace_key, plan_id, case_id, case_revision) ON DELETE RESTRICT,
        CHECK (purpose <> 'counterevidence' OR evidence_intent = 'challenging')
      );

      CREATE TABLE IF NOT EXISTS research_plan_query_hypotheses (
        workspace_key TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        query_id TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        hypothesis_revision INTEGER NOT NULL,
        PRIMARY KEY (workspace_key, plan_id, query_id, hypothesis_id),
        FOREIGN KEY (workspace_key, plan_id, query_id)
          REFERENCES research_plan_queries(workspace_key, plan_id, query_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, plan_id, query_id, case_id)
          REFERENCES research_plan_queries(workspace_key, plan_id, query_id, case_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, case_id, hypothesis_id, hypothesis_revision)
          REFERENCES research_hypothesis_revisions(workspace_key, case_id, hypothesis_id, revision) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_source_versions (
        workspace_key TEXT NOT NULL,
        source_item_id INTEGER NOT NULL,
        source_text_hash TEXT NOT NULL,
        retrieved_at_utc TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        body_text TEXT NOT NULL,
        PRIMARY KEY (workspace_key, source_item_id, source_text_hash, retrieved_at_utc),
        FOREIGN KEY (source_item_id) REFERENCES source_items(id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_runs (
        workspace_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        case_revision INTEGER NOT NULL,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'cancellation_requested', 'completed', 'failed', 'cancelled', 'interrupted')),
        snapshot_json TEXT NOT NULL,
        usage_json TEXT NOT NULL,
        coverage_gaps_json TEXT NOT NULL,
        assessment_json TEXT,
        stopping_reason TEXT CHECK (stopping_reason IS NULL OR stopping_reason IN ('all_steps_finished', 'cancelled', 'provider_unavailable', 'limit_reached', 'deadline_reached', 'step_failed', 'service_shutdown', 'lease_lost')),
        created_at_utc TEXT NOT NULL,
        started_at_utc TEXT,
        finished_at_utc TEXT,
        cancel_requested_at_utc TEXT,
        PRIMARY KEY (workspace_key, run_id),
        UNIQUE (workspace_key, run_id, case_id),
        FOREIGN KEY (workspace_key, case_id, case_revision)
          REFERENCES research_case_revisions(workspace_key, case_id, revision) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, plan_id, case_id, case_revision)
          REFERENCES research_plans(workspace_key, plan_id, case_id, case_revision) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_run_hypotheses (
        workspace_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        hypothesis_revision INTEGER NOT NULL,
        PRIMARY KEY (workspace_key, run_id, hypothesis_id),
        UNIQUE (workspace_key, run_id, case_id, hypothesis_id),
        FOREIGN KEY (workspace_key, run_id, case_id)
          REFERENCES research_runs(workspace_key, run_id, case_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, case_id, hypothesis_id, hypothesis_revision)
          REFERENCES research_hypothesis_revisions(workspace_key, case_id, hypothesis_id, revision) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_run_steps (
        workspace_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        step_name TEXT NOT NULL CHECK (step_name IN ('search', 'fetch_originals', 'map_evidence', 'assess')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped_unavailable', 'cancelled')),
        started_at_utc TEXT,
        finished_at_utc TEXT,
        failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
          'VALIDATION_ERROR', 'NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'BUSY',
          'PROVIDER_UNAVAILABLE', 'LIMIT_EXCEEDED', 'RUN_NOT_CANCELLABLE', 'UNAUTHENTICATED',
          'FORBIDDEN', 'RATE_LIMITED', 'INTERNAL_ERROR'
        )),
        provider_availability TEXT CHECK (provider_availability IS NULL OR provider_availability IN ('available', 'not_configured', 'unavailable')),
        PRIMARY KEY (workspace_key, run_id, step_name),
        FOREIGN KEY (workspace_key, run_id, case_id)
          REFERENCES research_runs(workspace_key, run_id, case_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_evidence (
        workspace_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('verified_excerpt', 'search_snippet')),
        hypothesis_id TEXT,
        relationship TEXT CHECK (relationship IS NULL OR relationship IN ('supports', 'contradicts', 'context')),
        source_item_id INTEGER,
        source_text_hash TEXT,
        retrieved_at_utc TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (workspace_key, run_id, evidence_id),
        UNIQUE (workspace_key, run_id, evidence_id, hypothesis_id, evidence_kind, relationship),
        FOREIGN KEY (workspace_key, run_id, case_id)
          REFERENCES research_runs(workspace_key, run_id, case_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, run_id, hypothesis_id)
          REFERENCES research_run_hypotheses(workspace_key, run_id, hypothesis_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, run_id, case_id, hypothesis_id)
          REFERENCES research_run_hypotheses(workspace_key, run_id, case_id, hypothesis_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, source_item_id, source_text_hash, retrieved_at_utc)
          REFERENCES research_source_versions(workspace_key, source_item_id, source_text_hash, retrieved_at_utc) ON DELETE RESTRICT,
        CHECK (
          (evidence_kind = 'verified_excerpt' AND hypothesis_id IS NOT NULL AND relationship IS NOT NULL AND source_item_id IS NOT NULL AND source_text_hash IS NOT NULL AND retrieved_at_utc IS NOT NULL)
          OR
          (evidence_kind = 'search_snippet' AND hypothesis_id IS NULL AND relationship IS NULL AND source_item_id IS NULL AND source_text_hash IS NULL AND retrieved_at_utc IS NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS research_assessments (
        workspace_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (workspace_key, run_id),
        UNIQUE (workspace_key, run_id, case_id),
        FOREIGN KEY (workspace_key, run_id, case_id)
          REFERENCES research_runs(workspace_key, run_id, case_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_assessment_claims (
        workspace_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('supported', 'mixed', 'contradicted', 'insufficient_evidence')),
        payload_json TEXT NOT NULL,
        PRIMARY KEY (workspace_key, run_id, hypothesis_id),
        FOREIGN KEY (workspace_key, run_id)
          REFERENCES research_assessments(workspace_key, run_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, run_id, case_id)
          REFERENCES research_assessments(workspace_key, run_id, case_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, run_id, hypothesis_id)
          REFERENCES research_run_hypotheses(workspace_key, run_id, hypothesis_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, run_id, case_id, hypothesis_id)
          REFERENCES research_run_hypotheses(workspace_key, run_id, case_id, hypothesis_id) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_assessment_evidence_refs (
        workspace_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        hypothesis_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        evidence_kind TEXT NOT NULL DEFAULT 'verified_excerpt' CHECK (evidence_kind = 'verified_excerpt'),
        relationship TEXT NOT NULL CHECK (relationship IN ('supports', 'contradicts')),
        PRIMARY KEY (workspace_key, run_id, hypothesis_id, evidence_id, relationship),
        FOREIGN KEY (workspace_key, run_id, hypothesis_id)
          REFERENCES research_assessment_claims(workspace_key, run_id, hypothesis_id) ON DELETE RESTRICT,
        FOREIGN KEY (workspace_key, run_id, evidence_id, hypothesis_id, evidence_kind, relationship)
          REFERENCES research_evidence(workspace_key, run_id, evidence_id, hypothesis_id, evidence_kind, relationship) ON DELETE RESTRICT
      );

      CREATE TABLE IF NOT EXISTS research_idempotency_receipts (
        workspace_key TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('research_case_create', 'research_case_update', 'research_plan', 'research_start', 'research_cancel')),
        idempotency_key TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        PRIMARY KEY (workspace_key, operation, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS research_workspace_leases (
        workspace_key TEXT PRIMARY KEY,
        fencing_epoch INTEGER NOT NULL DEFAULT 0 CHECK (fencing_epoch >= 0),
        owner_instance_id TEXT,
        run_id TEXT,
        expires_at_utc TEXT,
        renewed_at_utc TEXT,
        CHECK (
          (owner_instance_id IS NULL AND run_id IS NULL AND expires_at_utc IS NULL AND renewed_at_utc IS NULL)
          OR
          (owner_instance_id IS NOT NULL AND run_id IS NOT NULL AND expires_at_utc IS NOT NULL AND renewed_at_utc IS NOT NULL)
        ),
        FOREIGN KEY (workspace_key, run_id)
          REFERENCES research_runs(workspace_key, run_id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS ix_research_cases_workspace_updated
        ON research_cases(workspace_key, updated_at_utc);
      CREATE INDEX IF NOT EXISTS ix_research_plans_case_revision
        ON research_plans(workspace_key, case_id, case_revision);
      CREATE INDEX IF NOT EXISTS ix_research_runs_workspace_status
        ON research_runs(workspace_key, status, created_at_utc);
      CREATE INDEX IF NOT EXISTS ix_research_evidence_run
        ON research_evidence(workspace_key, run_id, evidence_id);
      CREATE INDEX IF NOT EXISTS ix_research_source_versions_source
        ON research_source_versions(workspace_key, source_item_id, source_text_hash);

      CREATE TRIGGER IF NOT EXISTS research_suggestions_immutable_update
        BEFORE UPDATE ON research_hypothesis_suggestions
        BEGIN SELECT RAISE(ABORT, 'research suggestion records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_suggestions_immutable_delete
        BEFORE DELETE ON research_hypothesis_suggestions
        BEGIN SELECT RAISE(ABORT, 'research suggestion records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_cases_immutable_delete
        BEFORE DELETE ON research_cases
        BEGIN SELECT RAISE(ABORT, 'research cases cannot be deleted'); END;
      CREATE TRIGGER IF NOT EXISTS research_case_revisions_immutable_update
        BEFORE UPDATE ON research_case_revisions
        BEGIN SELECT RAISE(ABORT, 'research case revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_case_revisions_immutable_delete
        BEFORE DELETE ON research_case_revisions
        BEGIN SELECT RAISE(ABORT, 'research case revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_hypothesis_revisions_immutable_update
        BEFORE UPDATE ON research_hypothesis_revisions
        BEGIN SELECT RAISE(ABORT, 'research hypothesis revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_hypothesis_revisions_immutable_delete
        BEFORE DELETE ON research_hypothesis_revisions
        BEGIN SELECT RAISE(ABORT, 'research hypothesis revisions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_plans_immutable_update
        BEFORE UPDATE ON research_plans
        BEGIN SELECT RAISE(ABORT, 'research plans are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_plans_immutable_delete
        BEFORE DELETE ON research_plans
        BEGIN SELECT RAISE(ABORT, 'research plans are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_plan_queries_immutable_update
        BEFORE UPDATE ON research_plan_queries
        BEGIN SELECT RAISE(ABORT, 'research plan queries are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_plan_queries_immutable_delete
        BEFORE DELETE ON research_plan_queries
        BEGIN SELECT RAISE(ABORT, 'research plan queries are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_plan_hypotheses_immutable_update
        BEFORE UPDATE ON research_plan_query_hypotheses
        BEGIN SELECT RAISE(ABORT, 'research plan hypothesis mappings are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_plan_hypotheses_immutable_delete
        BEFORE DELETE ON research_plan_query_hypotheses
        BEGIN SELECT RAISE(ABORT, 'research plan hypothesis mappings are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_source_versions_immutable_update
        BEFORE UPDATE ON research_source_versions
        BEGIN SELECT RAISE(ABORT, 'research source versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_source_versions_immutable_delete
        BEFORE DELETE ON research_source_versions
        BEGIN SELECT RAISE(ABORT, 'research source versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_run_snapshot_immutable_update
        BEFORE UPDATE OF case_id, case_revision, plan_id, snapshot_json, created_at_utc ON research_runs
        BEGIN SELECT RAISE(ABORT, 'research run snapshots are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_runs_immutable_delete
        BEFORE DELETE ON research_runs
        BEGIN SELECT RAISE(ABORT, 'research runs cannot be deleted'); END;
      CREATE TRIGGER IF NOT EXISTS research_evidence_immutable_update
        BEFORE UPDATE ON research_evidence
        BEGIN SELECT RAISE(ABORT, 'research evidence records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_evidence_immutable_delete
        BEFORE DELETE ON research_evidence
        BEGIN SELECT RAISE(ABORT, 'research evidence records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_assessments_immutable_update
        BEFORE UPDATE ON research_assessments
        BEGIN SELECT RAISE(ABORT, 'research assessments are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_assessments_immutable_delete
        BEFORE DELETE ON research_assessments
        BEGIN SELECT RAISE(ABORT, 'research assessments are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_assessment_claims_immutable_update
        BEFORE UPDATE ON research_assessment_claims
        BEGIN SELECT RAISE(ABORT, 'research assessment claims are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_assessment_claims_immutable_delete
        BEFORE DELETE ON research_assessment_claims
        BEGIN SELECT RAISE(ABORT, 'research assessment claims are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_assessment_refs_immutable_update
        BEFORE UPDATE ON research_assessment_evidence_refs
        BEGIN SELECT RAISE(ABORT, 'research assessment references are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_assessment_refs_immutable_delete
        BEFORE DELETE ON research_assessment_evidence_refs
        BEGIN SELECT RAISE(ABORT, 'research assessment references are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_idempotency_immutable_update
        BEFORE UPDATE ON research_idempotency_receipts
        BEGIN SELECT RAISE(ABORT, 'research idempotency receipts are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS research_idempotency_immutable_delete
        BEFORE DELETE ON research_idempotency_receipts
        BEGIN SELECT RAISE(ABORT, 'research idempotency receipts are immutable'); END;

      INSERT INTO research_schema_migrations(version, applied_at_utc)
        VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
  });

  apply.immediate();

  // Long-running provider calls cannot be wrapped in the synchronous receipt
  // transaction above. This additive table reserves their idempotency key
  // before dispatch and records whether the outcome is replayable or unknown.
  const applyExternalOperations = db.transaction(() => {
    const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM research_schema_migrations').get() as { version: number };
    if (current.version >= 2) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS research_external_operations (
        workspace_key TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation = 'research_plan'),
        idempotency_key TEXT NOT NULL,
        input_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'unknown')),
        result_json TEXT,
        usage_json TEXT,
        owner_id TEXT NOT NULL,
        fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch >= 1),
        started_at_utc TEXT NOT NULL,
        deadline_at_utc TEXT NOT NULL,
        updated_at_utc TEXT NOT NULL,
        PRIMARY KEY (workspace_key, operation, idempotency_key),
        CHECK ((status = 'pending' AND result_json IS NULL)
          OR (status = 'completed' AND result_json IS NOT NULL)
          OR (status = 'unknown' AND result_json IS NULL))
      );

      CREATE INDEX IF NOT EXISTS ix_research_external_operations_status
        ON research_external_operations(workspace_key, operation, status, deadline_at_utc);

      INSERT INTO research_schema_migrations(version, applied_at_utc)
        VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
  });

  applyExternalOperations.immediate();
}
