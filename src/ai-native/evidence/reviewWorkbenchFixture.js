export const SYNTHETIC_REVIEWER_ID = "reviewer-local-fixture";

export const SYNTHETIC_PIPELINE_STATE = Object.freeze({
  registry: Object.freeze([
    Object.freeze({ source_id: "src-fixture-map-listing", source_type: "map_listing", collection_status: "manual_only", next_review_due_at: null }),
    Object.freeze({ source_id: "src-fixture-reporting", source_type: "signed_reporting", collection_status: "manual_only", next_review_due_at: null }),
    Object.freeze({ source_id: "src-fixture-ugc", source_type: "traceable_ugc", collection_status: "manual_only", next_review_due_at: null }),
  ]),
});

const matched = Object.freeze({
  status: "matched",
  method: "exact_id",
  candidate_place_ids: Object.freeze(["hp-fixture-cafe"]),
  confidence: 1,
  requires_human_review: true,
});

export const SYNTHETIC_CANDIDATE_STATE = Object.freeze({
  candidates: Object.freeze([
    Object.freeze({
      candidate_id: "cand-aaaaaaaaaaaaaaaa",
      source_id: "src-fixture-map-listing",
      place_id: "hp-fixture-cafe",
      place_match: matched,
      attribute: "operating_status",
      normalized_value: "open",
      status: "candidate",
      review_status: "pending",
      content_trust: "untrusted",
    }),
    Object.freeze({
      candidate_id: "cand-bbbbbbbbbbbbbbbb",
      source_id: "src-fixture-reporting",
      place_id: "hp-fixture-cafe",
      place_match: matched,
      attribute: "operating_status",
      normalized_value: "open",
      status: "candidate",
      review_status: "pending",
      content_trust: "untrusted",
    }),
    Object.freeze({
      candidate_id: "cand-cccccccccccccccc",
      source_id: "src-fixture-ugc",
      place_id: "hp-fixture-cafe",
      place_match: matched,
      attribute: "operating_status",
      normalized_value: "temporarily_closed",
      status: "candidate",
      review_status: "pending",
      content_trust: "untrusted",
    }),
  ]),
  deduplication_clusters: Object.freeze([
    Object.freeze({
      cluster_id: "dedup-dddddddddddddddd",
      candidate_ids: Object.freeze(["cand-aaaaaaaaaaaaaaaa", "cand-bbbbbbbbbbbbbbbb"]),
      source_ids: Object.freeze(["src-fixture-map-listing", "src-fixture-reporting"]),
      place_id: "hp-fixture-cafe",
      attribute: "operating_status",
      status: "duplicate_cluster",
      review_status: "pending",
      requires_human_review: true,
    }),
  ]),
  conflict_queue: Object.freeze([
    Object.freeze({
      conflict_id: "conflict-eeeeeeeeeeeeeeee",
      candidate_ids: Object.freeze(["cand-aaaaaaaaaaaaaaaa", "cand-cccccccccccccccc"]),
      place_id: "hp-fixture-cafe",
      attribute: "operating_status",
      reason: "normalized_value_disagreement",
      severity: "high",
      comparison_scope: "same_time_scope",
      status: "pending_review",
      requires_human_review: true,
    }),
  ]),
});

export function syntheticSubject(subjectType, subjectId) {
  if (subjectType === "source") return SYNTHETIC_PIPELINE_STATE.registry.find((item) => item.source_id === subjectId) ?? null;
  if (subjectType === "candidate") return SYNTHETIC_CANDIDATE_STATE.candidates.find((item) => item.candidate_id === subjectId) ?? null;
  if (subjectType === "deduplication_cluster") return SYNTHETIC_CANDIDATE_STATE.deduplication_clusters.find((item) => item.cluster_id === subjectId) ?? null;
  if (subjectType === "conflict") return SYNTHETIC_CANDIDATE_STATE.conflict_queue.find((item) => item.conflict_id === subjectId) ?? null;
  return null;
}
