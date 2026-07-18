import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initSchema } from './schema.ts';
import { revalidateReviewGate } from './review-gate-revalidation.ts';

function seed(db: Database.Database) {
  const now='2026-07-18T00:00:00.000Z';
  const opportunityId=Number(db.prepare(`INSERT INTO opportunities (slug,title,thesis,score,market_score,taste_adjustment,final_score,status,lifecycle_stage,cluster_key,metadata_json,created_at_utc,updated_at_utc) VALUES ('thin','Thin evidence','Teams need invoice automation',9.5,9.5,0,9.5,'active','review_gate','invoice','{}',?,?)`).run(now,now).lastInsertRowid);
  const runId=Number(db.prepare(`INSERT INTO runs (run_type,target_type,target_id,status,requested_by,started_at_utc,metadata_json) VALUES ('research','opportunity',?,'review_gate','system',?,'{}')`).run(String(opportunityId),now).lastInsertRowid);
  db.prepare(`INSERT INTO artifacts (run_id,opportunity_id,path,created_at_utc) VALUES (?,?,'/tmp/draft.md',?)`).run(runId,opportunityId,now);
  return {opportunityId,runId};
}
describe('revalidateReviewGate',()=>{
  it('is read-only unless apply is requested',async()=>{
    const db=new Database(':memory:');initSchema(db);const seeded=seed(db);
    const before=db.serialize();
    const result=await revalidateReviewGate(db);
    expect(result[0].disposition).toBe('needs_more_evidence');
    expect(db.serialize()).toEqual(before);
    expect((db.prepare('SELECT lifecycle_stage FROM opportunities WHERE id=?').get(seeded.opportunityId) as any).lifecycle_stage).toBe('review_gate');
  });
  it('archives failures with an audit event while retaining drafts and artifacts',async()=>{
    const db=new Database(':memory:');initSchema(db);const {opportunityId,runId}=seed(db);
    await revalidateReviewGate(db,{apply:true});
    expect(db.prepare('SELECT lifecycle_stage,status FROM opportunities WHERE id=?').get(opportunityId)).toEqual({lifecycle_stage:'archived',status:'archived'});
    expect((db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as any).status).toBe('needs_more_evidence');
    expect((db.prepare('SELECT COUNT(*) count FROM artifacts').get() as any).count).toBe(1);
    expect((db.prepare("SELECT COUNT(*) count FROM run_events WHERE event_type='review_gate.revalidated'").get() as any).count).toBe(1);
  });
  it('does not revalidate terminal opportunities even when a stale review run exists', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const { opportunityId, runId } = seed(db);
    db.prepare("UPDATE opportunities SET lifecycle_stage='approved', status='active' WHERE id=?").run(opportunityId);

    const result = await revalidateReviewGate(db, { apply: true });

    expect(result).toEqual([]);
    expect(db.prepare('SELECT lifecycle_stage,status FROM opportunities WHERE id=?').get(opportunityId)).toEqual({ lifecycle_stage:'approved', status:'active' });
    expect((db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as any).status).toBe('review_gate');
  });
  it('records a null-run audit event for a review-gate opportunity without a run', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const now='2026-07-18T00:00:00.000Z';
    const opportunityId=Number(db.prepare(`INSERT INTO opportunities (slug,title,thesis,score,market_score,taste_adjustment,final_score,status,lifecycle_stage,cluster_key,metadata_json,created_at_utc,updated_at_utc) VALUES ('no-run','No run','Teams need invoice automation',9.5,9.5,0,9.5,'active','review_gate','invoice','{}',?,?)`).run(now,now).lastInsertRowid);

    await revalidateReviewGate(db, { apply: true });

    expect(db.prepare('SELECT lifecycle_stage,status FROM opportunities WHERE id=?').get(opportunityId)).toEqual({ lifecycle_stage:'archived', status:'archived' });
    expect(db.prepare("SELECT run_id,opportunity_id FROM run_events WHERE event_type='review_gate.revalidated'").get()).toEqual({ run_id:null, opportunity_id:opportunityId });
  });
  it('rolls back lifecycle and run state when audit recording fails', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const { opportunityId, runId } = seed(db);
    db.exec(`CREATE TRIGGER fail_revalidation_event BEFORE INSERT ON run_events WHEN NEW.event_type='review_gate.revalidated' BEGIN SELECT RAISE(ABORT, 'audit failure'); END;`);

    await expect(revalidateReviewGate(db, { apply: true })).rejects.toThrow('audit failure');

    expect(db.prepare('SELECT lifecycle_stage,status FROM opportunities WHERE id=?').get(opportunityId)).toEqual({ lifecycle_stage:'review_gate', status:'active' });
    expect((db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as any).status).toBe('review_gate');
  });
});
