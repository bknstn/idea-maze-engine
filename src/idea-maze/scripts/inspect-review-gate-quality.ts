import { closeDb, getDb } from './lib/db.ts';
import {
  evaluateReviewGateCandidate,
  unavailableEvidenceAligner,
} from './lib/review-gate-revalidation.ts';
import { AUTO_PUBLISH_MIN_BUCKET } from './lib/opportunity-policy.ts';

function rowsToCounts(rows: Array<{reason:string|null;count:number}>): Record<string,number> { return Object.fromEntries(rows.map((row)=>[row.reason ?? 'unknown',Number(row.count)])); }
function scalar(db:ReturnType<typeof getDb>,sql:string):number { return Number((db.prepare(sql).get() as {value:number|null}).value ?? 0); }
function nullable(db:ReturnType<typeof getDb>,sql:string):number|null { const value=(db.prepare(sql).get() as {value:number|null}).value; return value==null?null:Number(value); }

async function main() {
  const db=getDb();
  try {
    const candidates=db.prepare(`
      SELECT DISTINCT o.id, o.slug, o.title, o.thesis, o.cluster_key,
             o.final_score, NULL AS run_id
      FROM opportunities o
      LEFT JOIN runs r
        ON r.target_type='opportunity'
       AND (r.target_id=CAST(o.id AS TEXT) OR r.target_id=o.slug)
      WHERE o.lifecycle_stage NOT IN ('approved', 'rejected')
        AND (
          (o.status='active' AND o.final_score>=?)
          OR o.lifecycle_stage='review_gate'
          OR r.status IN ('draft_ready','review_gate')
        )
      ORDER BY o.final_score DESC, o.id
    `).all(AUTO_PUBLISH_MIN_BUCKET) as Array<{id:number;slug:string;title:string;thesis:string;cluster_key:string;final_score:number;run_id:null}>;
    const candidateEvaluations=[];
    for(const candidate of candidates) {
      candidateEvaluations.push(
        await evaluateReviewGateCandidate(db, candidate, unavailableEvidenceAligner),
      );
    }
    const recentReviewed=scalar(db,`SELECT COUNT(*) value FROM (SELECT id FROM runs WHERE status IN ('approved','rejected') ORDER BY COALESCE(completed_at_utc,started_at_utc) DESC LIMIT 30)`);
    const recentFalsePasses=scalar(db,`
      WITH recent AS (
        SELECT r.id, r.status, r.started_at_utc, o.id AS opportunity_id
        FROM runs r
        JOIN opportunities o ON (r.target_id=CAST(o.id AS TEXT) OR r.target_id=o.slug)
        WHERE r.status IN ('approved','rejected')
        ORDER BY COALESCE(r.completed_at_utc,r.started_at_utc) DESC
        LIMIT 30
      )
      SELECT COUNT(*) value
      FROM recent reviewed
      WHERE reviewed.status='rejected'
        AND EXISTS (
          SELECT 1
          FROM run_events evidence_event
          WHERE evidence_event.id = (
            SELECT prior.id
            FROM run_events prior
            WHERE prior.opportunity_id=reviewed.opportunity_id
              AND prior.event_type='opportunity.evidence_evaluated'
              AND prior.created_at_utc<=reviewed.started_at_utc
            ORDER BY prior.created_at_utc DESC, prior.id DESC
            LIMIT 1
          )
            AND json_extract(evidence_event.payload_json,'$.deterministic_evidence.disposition')='review_eligible'
            AND json_extract(evidence_event.payload_json,'$.alignment.disposition')='review_eligible'
            AND json_extract(evidence_event.payload_json,'$.automation_score')>=${AUTO_PUBLISH_MIN_BUCKET}
        )
    `);
    const report={
      candidates:candidateEvaluations.map((item)=>({slug:item.slug,raw_score:item.finalScore,automation_score:item.automationScore,aligned_buyer_source_count:item.alignedBuyerSourceCount,promo_count:item.alignment?.promoCount??item.deterministic.sourceQuality.promoCount,irrelevant_count:item.alignment?.irrelevantCount??item.deterministic.sourceQuality.irrelevantSourceCount,contradict_count:item.alignment?.contradictCount??0,duplicate:item.duplicate,reasons:item.reasons,disposition:item.disposition})),
      average_final_score_recent_rejected_runs:nullable(db,`SELECT AVG(o.final_score) value FROM runs r JOIN opportunities o ON (r.target_id=CAST(o.id AS TEXT) OR r.target_id=o.slug) WHERE r.status='rejected' AND r.started_at_utc>=datetime('now','-30 days')`),
      archive_reason_counts:rowsToCounts(db.prepare(`SELECT json_extract(metadata_json,'$.archive_reason') reason,COUNT(*) count FROM opportunities WHERE json_extract(metadata_json,'$.archive_reason') IS NOT NULL GROUP BY reason ORDER BY count DESC`).all() as any),
      top_rejection_reasons:rowsToCounts(db.prepare(`SELECT feature_value reason,COUNT(*) count FROM feedback_features WHERE feature_type='rejection_reason' GROUP BY feature_value ORDER BY count DESC,reason LIMIT 10`).all() as any),
      rolling_last_30_human_reviewed:{total:recentReviewed,false_passes:recentFalsePasses,false_pass_rate:recentReviewed?recentFalsePasses/recentReviewed:0},
      pending_review_gate:scalar(db,"SELECT COUNT(*) value FROM runs WHERE status='review_gate'"),
    };
    console.log(JSON.stringify(report,null,2));
  } finally { closeDb(); }
}
main().catch((error)=>{console.error(error);process.exitCode=1;});
