import {
  EVIDENCE_REVIEW_SCHEMA_VERSION,
  REVIEW_OUTCOMES,
  assertReviewContract,
} from "./reviewWorkbenchContracts.js";
import { stableHexId } from "./stableId.js";

const outcomeReasonCodes = Object.freeze({
  source_confirmed: new Set(["source_current"]),
  source_manual_only: new Set(["source_terms_pending", "source_permission_unclear"]),
  source_blocked: new Set(["source_permission_unclear", "source_withdrawn"]),
  source_retired: new Set(["source_withdrawn"]),
  candidate_approved: new Set(["candidate_source_supported"]),
  candidate_rejected: new Set(["candidate_source_unsupported", "candidate_identity_unclear", "candidate_attribute_incorrect"]),
  candidate_needs_changes: new Set(["candidate_identity_unclear", "candidate_attribute_incorrect"]),
  duplicates_merge: new Set(["duplicate_exact_match"]),
  duplicates_keep_separate: new Set(["duplicate_distinct_observation"]),
  duplicates_needs_changes: new Set(["candidate_attribute_incorrect"]),
  conflict_keep_candidate: new Set(["conflict_newer_supported"]),
  conflict_keep_existing: new Set(["conflict_existing_still_authoritative"]),
  conflict_reject_all: new Set(["conflict_all_candidates_invalid"]),
  conflict_unresolved: new Set(["conflict_insufficient_evidence"]),
});
const priorityOrder = Object.freeze({ high: 0, medium: 1, low: 2 });

function decisionId(input) {
  return `review-${stableHexId([
    input.subject_type,
    input.subject_id,
    input.review_context,
    input.outcome,
    input.selected_candidate_id ?? "",
    input.reason_code,
    input.reviewer_id,
    input.reviewed_at,
  ].join("|"))}`;
}

function subjectId(subjectType, subject) {
  return {
    source: subject?.source_id,
    candidate: subject?.candidate_id,
    deduplication_cluster: subject?.cluster_id,
    conflict: subject?.conflict_id,
  }[subjectType];
}

function candidateIdsForSubject(subjectType, subject) {
  if (subjectType === "candidate") return [subject.candidate_id];
  if (["deduplication_cluster", "conflict"].includes(subjectType)) return subject.candidate_ids;
  return [];
}

export function createReviewDecision({
  subjectType,
  subject,
  reviewContext,
  outcome,
  selectedCandidateId = null,
  reasonCode,
  reviewerId,
  reviewedAt,
  nextReviewDueAt = null,
}) {
  const allowedOutcomes = REVIEW_OUTCOMES[subjectType];
  if (!allowedOutcomes?.includes(outcome)) throw new Error("REVIEW_OUTCOME_NOT_ALLOWED");
  if (!outcomeReasonCodes[outcome]?.has(reasonCode)) throw new Error("REVIEW_REASON_NOT_ALLOWED");
  const id = subjectId(subjectType, subject);
  if (!id) throw new Error("REVIEW_SUBJECT_INVALID");
  const candidateIds = candidateIdsForSubject(subjectType, subject);
  const selectionRequired = ["duplicates_merge", "conflict_keep_candidate"].includes(outcome);
  if (selectionRequired && !candidateIds.includes(selectedCandidateId)) throw new Error("REVIEW_SELECTION_REQUIRED");
  if (!selectionRequired && selectedCandidateId !== null) throw new Error("REVIEW_SELECTION_UNEXPECTED");
  if (subjectType === "candidate" && outcome === "candidate_approved"
    && (subject.place_match?.status !== "matched" || subject.status !== "candidate")) {
    throw new Error("CANDIDATE_NOT_APPROVABLE");
  }
  if (subjectType !== "source" && nextReviewDueAt !== null) throw new Error("REVIEW_DUE_DATE_UNEXPECTED");
  if (subjectType === "source" && outcome !== "source_retired" && nextReviewDueAt === null) {
    throw new Error("SOURCE_REVIEW_DUE_DATE_REQUIRED");
  }

  const decision = {
    schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
    decision_id: "",
    subject_type: subjectType,
    subject_id: id,
    review_context: reviewContext,
    outcome,
    selected_candidate_id: selectedCandidateId,
    reason_code: reasonCode,
    reviewer_kind: "human",
    reviewer_id: reviewerId,
    reviewed_at: reviewedAt,
    next_review_due_at: nextReviewDueAt,
    requires_human_review: true,
    ai_is_reviewer: false,
  };
  decision.decision_id = decisionId(decision);
  return assertReviewContract("EvidenceReviewDecision", decision, decision.decision_id);
}

function latestDecisions(decisions, reviewContext) {
  const bySubject = new Map();
  for (const decision of decisions.filter((item) => item.review_context === reviewContext)) {
    assertReviewContract("EvidenceReviewDecision", decision, decision.decision_id);
    const existing = bySubject.get(decision.subject_id);
    if (!existing || Date.parse(existing.reviewed_at) < Date.parse(decision.reviewed_at)) {
      bySubject.set(decision.subject_id, decision);
    }
  }
  return bySubject;
}

function sourceFreshness(entry, decision, today) {
  if (decision?.outcome === "source_retired") return "retired";
  if (decision?.outcome === "source_blocked") return "blocked";
  const due = decision?.next_review_due_at ?? entry.next_review_due_at;
  if (!due) return "unassessed";
  if (due < today) return "overdue";
  if (due === today) return "due";
  return "current";
}

function queueItem({ subjectType, subjectId: id, reason, priority, contentTrust }) {
  return Object.freeze({
    work_item_id: `queue-${stableHexId(`${subjectType}|${id}|${reason}`)}`,
    subject_type: subjectType,
    subject_id: id,
    reason,
    priority,
    status: "pending",
    content_trust: contentTrust,
    requires_human_review: true,
  });
}

export function buildEvidenceReviewWorkbench({
  pipelineState,
  candidateState,
  reviewDecisions = [],
  reviewContext = "production",
  today,
}) {
  const decisions = latestDecisions(reviewDecisions, reviewContext);
  const sources = (pipelineState?.registry ?? []).map((entry) => ({
    source_id: entry.source_id,
    source_type: entry.source_type,
    collection_status: entry.collection_status,
    freshness: sourceFreshness(entry, decisions.get(entry.source_id), today),
    latest_decision_id: decisions.get(entry.source_id)?.decision_id ?? null,
  }));
  const queue = [];
  for (const source of sources) {
    if (["unassessed", "due", "overdue"].includes(source.freshness)) {
      queue.push(queueItem({
        subjectType: "source",
        subjectId: source.source_id,
        reason: `source_${source.freshness}`,
        priority: source.freshness === "overdue" ? "high" : "medium",
        contentTrust: "not_applicable",
      }));
    }
  }
  for (const candidate of candidateState?.candidates ?? []) {
    if (!decisions.has(candidate.candidate_id)) {
      queue.push(queueItem({
        subjectType: "candidate",
        subjectId: candidate.candidate_id,
        reason: candidate.place_match.status === "matched" ? "candidate_pending" : `candidate_${candidate.place_match.status}`,
        priority: candidate.place_match.status === "matched" ? "medium" : "high",
        contentTrust: "untrusted",
      }));
    }
  }
  for (const cluster of candidateState?.deduplication_clusters ?? []) {
    if (!decisions.has(cluster.cluster_id)) {
      queue.push(queueItem({
        subjectType: "deduplication_cluster",
        subjectId: cluster.cluster_id,
        reason: "deduplication_pending",
        priority: "medium",
        contentTrust: "untrusted",
      }));
    }
  }
  for (const conflict of candidateState?.conflict_queue ?? []) {
    if (!decisions.has(conflict.conflict_id)) {
      queue.push(queueItem({
        subjectType: "conflict",
        subjectId: conflict.conflict_id,
        reason: "conflict_pending",
        priority: conflict.severity === "high" ? "high" : "medium",
        contentTrust: "untrusted",
      }));
    }
  }
  queue.sort((left, right) => (priorityOrder[left.priority] - priorityOrder[right.priority])
    || left.work_item_id.localeCompare(right.work_item_id));
  return Object.freeze({
    review_schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
    review_context: reviewContext,
    sources: Object.freeze(sources),
    queue: Object.freeze(queue),
    metrics: Object.freeze({
      source_count: sources.length,
      source_review_due_count: sources.filter((source) => ["unassessed", "due", "overdue"].includes(source.freshness)).length,
      candidate_pending_count: queue.filter((item) => item.subject_type === "candidate").length,
      deduplication_pending_count: queue.filter((item) => item.subject_type === "deduplication_cluster").length,
      conflict_pending_count: queue.filter((item) => item.subject_type === "conflict").length,
      unresolved_work_item_count: queue.length,
    }),
  });
}

function applyResolutionSelections(approvedIds, candidateState, decisions) {
  const included = new Set(approvedIds);
  for (const cluster of candidateState.deduplication_clusters ?? []) {
    const decision = decisions.get(cluster.cluster_id);
    if (decision?.outcome === "duplicates_merge") {
      for (const candidateId of cluster.candidate_ids) {
        if (candidateId !== decision.selected_candidate_id) included.delete(candidateId);
      }
    }
  }
  for (const conflict of candidateState.conflict_queue ?? []) {
    const decision = decisions.get(conflict.conflict_id);
    if (decision?.outcome === "conflict_keep_candidate") {
      for (const candidateId of conflict.candidate_ids) {
        if (candidateId !== decision.selected_candidate_id) included.delete(candidateId);
      }
    } else if (["conflict_keep_existing", "conflict_reject_all"].includes(decision?.outcome)) {
      for (const candidateId of conflict.candidate_ids) included.delete(candidateId);
    }
  }
  return [...included].sort();
}

export function createEvidenceReleaseDraft({
  evidenceVersion,
  pipelineState,
  candidateState,
  reviewDecisions,
  inputMode,
  createdBy,
  createdAt,
}) {
  const decisions = latestDecisions(reviewDecisions, inputMode);
  const blocks = new Set();
  const candidates = candidateState?.candidates ?? [];
  const approvedIds = candidates
    .filter((candidate) => decisions.get(candidate.candidate_id)?.outcome === "candidate_approved")
    .map((candidate) => candidate.candidate_id);
  if (inputMode === "synthetic_fixture") blocks.add("SYNTHETIC_INPUT_FORBIDDEN");
  if (!approvedIds.length) blocks.add("NO_APPROVED_CANDIDATES");
  const releaseDate = createdAt.slice(0, 10);
  const approvedCandidates = candidates.filter((candidate) => approvedIds.includes(candidate.candidate_id));
  if (approvedCandidates.some((candidate) => {
    const sourceEntry = (pipelineState?.registry ?? []).find((entry) => entry.source_id === candidate.source_id);
    const sourceDecision = decisions.get(candidate.source_id);
    return !sourceEntry
      || !["source_confirmed", "source_manual_only"].includes(sourceDecision?.outcome)
      || !sourceDecision.next_review_due_at
      || sourceDecision.next_review_due_at < releaseDate;
  })) {
    blocks.add("SOURCE_REVIEW_REQUIRED");
  }
  if (candidates.some((candidate) => !decisions.has(candidate.candidate_id))) blocks.add("PENDING_CANDIDATE_REVIEW");
  if ((candidateState?.deduplication_clusters ?? []).some((cluster) => cluster.candidate_ids.some((id) => approvedIds.includes(id))
    && !["duplicates_merge", "duplicates_keep_separate"].includes(decisions.get(cluster.cluster_id)?.outcome))) {
    blocks.add("UNRESOLVED_DEDUPLICATION");
  }
  if ((candidateState?.conflict_queue ?? []).some((conflict) => conflict.candidate_ids.some((id) => approvedIds.includes(id))
    && !["conflict_keep_candidate", "conflict_keep_existing", "conflict_reject_all"].includes(decisions.get(conflict.conflict_id)?.outcome))) {
    blocks.add("UNRESOLVED_CONFLICT");
  }
  const includedCandidateIds = applyResolutionSelections(approvedIds, candidateState ?? {}, decisions);
  if (!includedCandidateIds.length) blocks.add("NO_APPROVED_CANDIDATES");
  const decisionIds = [...decisions.values()].map((decision) => decision.decision_id).sort();
  const release = {
    schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
    release_id: `release-${stableHexId(`${evidenceVersion}|${inputMode}|${includedCandidateIds.join(",")}|${decisionIds.join(",")}|${createdAt}`)}`,
    evidence_version: evidenceVersion,
    input_mode: inputMode,
    included_candidate_ids: includedCandidateIds,
    review_decision_ids: decisionIds,
    created_by: createdBy,
    created_at: createdAt,
    status: "draft",
    publish_ready: blocks.size === 0,
    blocking_codes: [...blocks].sort(),
    published_at: null,
    published_by: null,
    synthetic_input_count: inputMode === "synthetic_fixture" ? candidates.length : 0,
    requires_human_publish: true,
    ai_is_factual_source: false,
  };
  return assertReviewContract("EvidenceReleaseRecord", release, release.release_id);
}

export function publishEvidenceRelease(releaseDraft, { confirmed, publishedBy, publishedAt }) {
  assertReviewContract("EvidenceReleaseRecord", releaseDraft, releaseDraft?.release_id);
  if (confirmed !== true || releaseDraft.status !== "draft" || !releaseDraft.publish_ready
    || releaseDraft.input_mode !== "production" || releaseDraft.synthetic_input_count !== 0) {
    throw new Error("EVIDENCE_RELEASE_NOT_PUBLISHABLE");
  }
  return assertReviewContract("EvidenceReleaseRecord", {
    ...releaseDraft,
    status: "published",
    published_at: publishedAt,
    published_by: publishedBy,
  }, releaseDraft.release_id);
}

export function createEvidenceRollbackPlan({ fromRelease, toRelease, reasonCode, requestedBy, requestedAt }) {
  assertReviewContract("EvidenceReleaseRecord", fromRelease, fromRelease?.release_id);
  assertReviewContract("EvidenceReleaseRecord", toRelease, toRelease?.release_id);
  if (fromRelease.status !== "published" || toRelease.status !== "published"
    || fromRelease.release_id === toRelease.release_id) {
    throw new Error("EVIDENCE_ROLLBACK_NOT_ALLOWED");
  }
  const rollback = {
    schema_version: EVIDENCE_REVIEW_SCHEMA_VERSION,
    rollback_id: `rollback-${stableHexId(`${fromRelease.release_id}|${toRelease.release_id}|${reasonCode}|${requestedAt}`)}`,
    from_release_id: fromRelease.release_id,
    to_release_id: toRelease.release_id,
    reason_code: reasonCode,
    requested_by: requestedBy,
    requested_at: requestedAt,
    status: "pending_confirmation",
    requires_human_confirmation: true,
  };
  return assertReviewContract("EvidenceRollbackRecord", rollback, rollback.rollback_id);
}
