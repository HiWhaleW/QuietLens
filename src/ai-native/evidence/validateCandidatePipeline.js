import { assertCandidateContract } from "./candidateContracts.js";
import { candidateContentFingerprint, normalizedCandidateValueKey } from "./candidateEvidence.js";

function addIssue(issues, code, recordId, detail) {
  issues.push({ code, record_id: recordId, detail });
}

function validateRecords(issues, name, records, idField) {
  const seen = new Set();
  for (const record of records) {
    try {
      assertCandidateContract(name, record, record[idField] ?? name);
    } catch (error) {
      addIssue(issues, "SCHEMA_INVALID", record[idField] ?? name, error.message);
    }
    if (seen.has(record[idField])) addIssue(issues, "DUPLICATE_ID", record[idField], idField);
    seen.add(record[idField]);
  }
}

export function validateCandidatePipeline(candidateState, pipelineState, evidenceStore) {
  const issues = [];
  const candidates = candidateState?.candidates ?? [];
  const clusters = candidateState?.deduplication_clusters ?? [];
  const conflicts = candidateState?.conflict_queue ?? [];
  validateRecords(issues, "CandidateEvidenceRecord", candidates, "candidate_id");
  validateRecords(issues, "DeduplicationCluster", clusters, "cluster_id");
  validateRecords(issues, "ConflictQueueItem", conflicts, "conflict_id");

  const snapshotById = new Map((pipelineState?.snapshots ?? []).map((item) => [item.snapshot_id, item]));
  const registryById = new Map((pipelineState?.registry ?? []).map((item) => [item.source_id, item]));
  const sourceById = new Map((evidenceStore?.sources ?? []).map((item) => [item.source_id, item]));
  const candidateById = new Map(candidates.map((item) => [item.candidate_id, item]));

  for (const candidate of candidates) {
    const snapshot = snapshotById.get(candidate.snapshot_id);
    const registry = registryById.get(candidate.source_id);
    const source = sourceById.get(candidate.source_id);
    if (!snapshot || snapshot.status !== "captured") {
      addIssue(issues, "CAPTURED_SNAPSHOT_MISSING", candidate.candidate_id, candidate.snapshot_id);
    } else if (snapshot.source_id !== candidate.source_id) {
      addIssue(issues, "SNAPSHOT_SOURCE_MISMATCH", candidate.candidate_id, candidate.snapshot_id);
    }
    if (!registry || !source) addIssue(issues, "REGISTERED_SOURCE_MISSING", candidate.candidate_id, candidate.source_id);
    if (registry && !registry.permitted_attributes.includes(candidate.attribute)) {
      addIssue(issues, "ATTRIBUTE_NOT_PERMITTED", candidate.candidate_id, candidate.attribute);
    }
    if (candidate.place_id && !source?.supports_place_ids.includes(candidate.place_id)) {
      addIssue(issues, "PLACE_OUTSIDE_SOURCE_SCOPE", candidate.candidate_id, candidate.place_id);
    }
    if (candidate.content_fingerprint !== candidateContentFingerprint(candidate)) {
      addIssue(issues, "CONTENT_FINGERPRINT_MISMATCH", candidate.candidate_id, candidate.content_fingerprint);
    }
    if (candidate.source_type === "traceable_ugc" && !candidate.risk_flags.includes("traceable_ugc")) {
      addIssue(issues, "UGC_RISK_FLAG_MISSING", candidate.candidate_id, candidate.source_id);
    }
    if (candidate.place_match.status !== "matched"
      && !candidate.risk_flags.some((flag) => ["identity_ambiguous", "place_unmatched"].includes(flag))) {
      addIssue(issues, "PLACE_RISK_FLAG_MISSING", candidate.candidate_id, candidate.place_match.status);
    }
  }

  for (const cluster of clusters) {
    const members = cluster.candidate_ids.map((id) => candidateById.get(id));
    if (members.some((member) => !member)) {
      addIssue(issues, "DEDUP_CANDIDATE_MISSING", cluster.cluster_id, cluster.candidate_ids.join(","));
      continue;
    }
    if (members.some((member) => member.content_fingerprint !== cluster.content_fingerprint)) {
      addIssue(issues, "DEDUP_FINGERPRINT_MISMATCH", cluster.cluster_id, cluster.content_fingerprint);
    }
  }

  for (const conflict of conflicts) {
    const members = conflict.candidate_ids.map((id) => candidateById.get(id));
    if (members.some((member) => !member)) {
      addIssue(issues, "CONFLICT_CANDIDATE_MISSING", conflict.conflict_id, conflict.candidate_ids.join(","));
      continue;
    }
    if (members.some((member) => member.place_id !== conflict.place_id || member.attribute !== conflict.attribute)) {
      addIssue(issues, "CONFLICT_SCOPE_MISMATCH", conflict.conflict_id, conflict.place_id);
    }
    if (new Set(members.map((member) => normalizedCandidateValueKey(member.normalized_value))).size < 2) {
      addIssue(issues, "CONFLICT_VALUES_NOT_DISTINCT", conflict.conflict_id, conflict.attribute);
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    metrics: {
      candidate_count: candidates.length,
      matched_candidate_count: candidates.filter((item) => item.place_match.status === "matched").length,
      pending_review_count: candidates.filter((item) => item.review_status === "pending").length,
      deduplication_cluster_count: clusters.length,
      conflict_queue_count: conflicts.length,
      published_candidate_count: candidates.filter((item) => item.status !== "candidate").length,
      ai_factual_source_count: candidates.filter((item) => item.ai_is_factual_source !== false).length,
    },
  };
}

export function assertCandidatePipeline(candidateState, pipelineState, evidenceStore) {
  const result = validateCandidatePipeline(candidateState, pipelineState, evidenceStore);
  if (!result.valid) {
    throw new Error(result.issues.map((item) => `${item.code}:${item.record_id}:${item.detail}`).join("; "));
  }
  return result;
}
