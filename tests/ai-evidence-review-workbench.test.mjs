import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConflictQueue,
  buildDeduplicationClusters,
  createCandidateEvidence,
} from "../src/ai-native/evidence/candidateEvidence.js";
import { buildEvidencePipelineBaseline } from "../src/ai-native/evidence/pipelineRegistry.js";
import { validateReviewContract } from "../src/ai-native/evidence/reviewWorkbenchContracts.js";
import {
  buildEvidenceReviewWorkbench,
  createEvidenceReleaseDraft,
  createEvidenceRollbackPlan,
  createReviewDecision,
  publishEvidenceRelease,
} from "../src/ai-native/evidence/reviewWorkbench.js";
import { loadEvidenceStore } from "./phase3b-fixtures.mjs";

const evidenceStore = await loadEvidenceStore();
const syntheticReviewer = "reviewer-synthetic-fixture";
const syntheticReviewedAt = "2026-08-19T12:00:00+08:00";

function pipelineWithSnapshots(sourceIds) {
  const pipeline = buildEvidencePipelineBaseline(evidenceStore);
  sourceIds.forEach((sourceId, index) => {
    const source = evidenceStore.sources.find((item) => item.source_id === sourceId);
    const registry = pipeline.registry.find((item) => item.source_id === sourceId);
    pipeline.snapshots.push({
      schema_version: "1.0.0",
      snapshot_id: `snap-review-fixture-${index + 1}`,
      run_id: `run-review-fixture-${index + 1}`,
      source_id: sourceId,
      access_plan_id: registry.access_plan_id,
      captured_at: `2026-08-19T10:0${index}:00+08:00`,
      status: "captured",
      source_url: source.url,
      http_status: null,
      content_type: "text/plain",
      content_length: 64,
      content_sha256: String(index + 1).repeat(64),
      payload_ref: `urn:quietlens:raw:review-fixture-${index + 1}`,
      storage_mode: "metadata_excerpt",
      personal_data_status: "none",
      ugc_full_text_stored: false,
      error_code: null,
      retry_after_at: null,
    });
  });
  return pipeline;
}

function candidateDraft(snapshotId, overrides = {}) {
  return {
    snapshot_id: snapshotId,
    place_id_hint: "hp-east-sea",
    place_hints: [],
    branch_context_confirmed: true,
    attribute: "operating_status",
    source_excerpt_untrusted: "本地合成审核输入：门店状态候选。",
    normalized_value: "open",
    observed_at: "2026-08-19T10:00:00+08:00",
    published_at: null,
    applicable_time: null,
    extraction_method: "deterministic",
    extraction_model: null,
    contains_personal_identifiers: false,
    ...overrides,
  };
}

function syntheticCandidateState() {
  const pipeline = pipelineWithSnapshots(["src-east-jfdaily", "src-east-observer", "src-east-paper"]);
  const first = createCandidateEvidence(candidateDraft("snap-review-fixture-1"), pipeline, evidenceStore);
  const duplicate = createCandidateEvidence(candidateDraft("snap-review-fixture-2", {
    source_excerpt_untrusted: "本地合成审核输入：营业状态相同。",
  }), pipeline, evidenceStore);
  const contrary = createCandidateEvidence(candidateDraft("snap-review-fixture-3", {
    source_excerpt_untrusted: "本地合成审核输入：暂停营业候选。",
    normalized_value: "temporarily_closed",
  }), pipeline, evidenceStore);
  const candidates = [first, duplicate, contrary];
  return {
    pipeline,
    state: {
      candidates,
      deduplication_clusters: buildDeduplicationClusters(candidates),
      conflict_queue: buildConflictQueue(candidates),
    },
  };
}

function decision(subjectType, subject, outcome, reasonCode, selectedCandidateId = null) {
  return createReviewDecision({
    subjectType,
    subject,
    reviewContext: "synthetic_fixture",
    outcome,
    selectedCandidateId,
    reasonCode,
    reviewerId: syntheticReviewer,
    reviewedAt: syntheticReviewedAt,
  });
}

function sourceDecision(sourceEntry) {
  return createReviewDecision({
    subjectType: "source",
    subject: sourceEntry,
    reviewContext: "synthetic_fixture",
    outcome: "source_confirmed",
    reasonCode: "source_current",
    reviewerId: syntheticReviewer,
    reviewedAt: syntheticReviewedAt,
    nextReviewDueAt: "2026-09-19",
  });
}

test("builds a source freshness queue without inventing review results", () => {
  const pipeline = buildEvidencePipelineBaseline(evidenceStore);
  const workbench = buildEvidenceReviewWorkbench({
    pipelineState: pipeline,
    candidateState: { candidates: [], deduplication_clusters: [], conflict_queue: [] },
    reviewContext: "production",
    reviewDecisions: [],
    today: "2026-08-19",
  });
  assert.equal(workbench.metrics.source_count, 32);
  assert.equal(workbench.metrics.source_review_due_count, 32);
  assert.equal(workbench.metrics.unresolved_work_item_count, 32);
  assert.ok(workbench.queue.every((item) => item.requires_human_review));
  assert.ok(workbench.sources.every((source) => source.latest_decision_id === null));
});

test("uses a controlled source review date to clear only that source from the freshness queue", () => {
  const pipeline = buildEvidencePipelineBaseline(evidenceStore);
  const sourceEntry = pipeline.registry[0];
  assert.throws(() => createReviewDecision({
    subjectType: "source",
    subject: sourceEntry,
    reviewContext: "synthetic_fixture",
    outcome: "source_confirmed",
    reasonCode: "source_current",
    reviewerId: syntheticReviewer,
    reviewedAt: syntheticReviewedAt,
  }), /SOURCE_REVIEW_DUE_DATE_REQUIRED/);
  const sourceDecision = createReviewDecision({
    subjectType: "source",
    subject: sourceEntry,
    reviewContext: "synthetic_fixture",
    outcome: "source_confirmed",
    reasonCode: "source_current",
    reviewerId: syntheticReviewer,
    reviewedAt: syntheticReviewedAt,
    nextReviewDueAt: "2026-09-19",
  });
  const workbench = buildEvidenceReviewWorkbench({
    pipelineState: pipeline,
    candidateState: { candidates: [], deduplication_clusters: [], conflict_queue: [] },
    reviewContext: "synthetic_fixture",
    reviewDecisions: [sourceDecision],
    today: "2026-08-19",
  });
  assert.equal(workbench.metrics.source_review_due_count, 31);
  assert.equal(workbench.sources.find((source) => source.source_id === sourceEntry.source_id).freshness, "current");
  assert.equal(workbench.queue.some((item) => item.subject_id === sourceEntry.source_id), false);
});

test("queues candidates, exact duplicates, and conflicts as separate human work items", () => {
  const fixture = syntheticCandidateState();
  const workbench = buildEvidenceReviewWorkbench({
    pipelineState: fixture.pipeline,
    candidateState: fixture.state,
    reviewContext: "synthetic_fixture",
    reviewDecisions: [],
    today: "2026-08-19",
  });
  assert.equal(workbench.metrics.candidate_pending_count, 3);
  assert.equal(workbench.metrics.deduplication_pending_count, 1);
  assert.equal(workbench.metrics.conflict_pending_count, 1);
  assert.ok(workbench.queue.filter((item) => item.subject_type !== "source")
    .every((item) => item.content_trust === "untrusted"));
});

test("records only controlled, explicitly human review decisions", () => {
  const fixture = syntheticCandidateState();
  const approved = decision(
    "candidate",
    fixture.state.candidates[0],
    "candidate_approved",
    "candidate_source_supported",
  );
  assert.equal(approved.reviewer_kind, "human");
  assert.equal(approved.ai_is_reviewer, false);
  assert.equal(approved.review_context, "synthetic_fixture");
  assert.equal(validateReviewContract("EvidenceReviewDecision", { ...approved, ai_is_reviewer: true }).valid, false);
  assert.equal(validateReviewContract("EvidenceReviewDecision", { ...approved, free_text_notes: "unbounded" }).valid, false);
});

test("does not approve an unmatched candidate even in a fixture", () => {
  const fixture = syntheticCandidateState();
  const unmatched = {
    ...fixture.state.candidates[0],
    place_id: null,
    place_match: {
      status: "unmatched",
      method: "none",
      candidate_place_ids: ["hp-east-sea"],
      confidence: 0,
      requires_human_review: true,
    },
  };
  assert.throws(() => decision(
    "candidate",
    unmatched,
    "candidate_approved",
    "candidate_source_supported",
  ), /CANDIDATE_NOT_APPROVABLE/);
});

test("resolves the synthetic queue but still blocks release publication", () => {
  const fixture = syntheticCandidateState();
  const [first, duplicate, contrary] = fixture.state.candidates;
  const cluster = fixture.state.deduplication_clusters[0];
  const conflict = fixture.state.conflict_queue[0];
  const decisions = [
    ...["src-east-jfdaily", "src-east-observer", "src-east-paper"].map((sourceId) => sourceDecision(
      fixture.pipeline.registry.find((entry) => entry.source_id === sourceId),
    )),
    decision("candidate", first, "candidate_approved", "candidate_source_supported"),
    decision("candidate", duplicate, "candidate_approved", "candidate_source_supported"),
    decision("candidate", contrary, "candidate_rejected", "candidate_source_unsupported"),
    decision("deduplication_cluster", cluster, "duplicates_merge", "duplicate_exact_match", first.candidate_id),
    decision("conflict", conflict, "conflict_keep_candidate", "conflict_newer_supported", first.candidate_id),
  ];
  const workbench = buildEvidenceReviewWorkbench({
    pipelineState: fixture.pipeline,
    candidateState: fixture.state,
    reviewContext: "synthetic_fixture",
    reviewDecisions: decisions,
    today: "2026-08-19",
  });
  assert.equal(workbench.metrics.candidate_pending_count, 0);
  assert.equal(workbench.metrics.deduplication_pending_count, 0);
  assert.equal(workbench.metrics.conflict_pending_count, 0);

  const release = createEvidenceReleaseDraft({
    evidenceVersion: "v1.0.0-fixture.1",
    pipelineState: fixture.pipeline,
    candidateState: fixture.state,
    reviewDecisions: decisions,
    inputMode: "synthetic_fixture",
    createdBy: syntheticReviewer,
    createdAt: "2026-08-19T12:30:00+08:00",
  });
  assert.deepEqual(release.included_candidate_ids, [first.candidate_id]);
  assert.equal(release.publish_ready, false);
  assert.deepEqual(release.blocking_codes, ["SYNTHETIC_INPUT_FORBIDDEN"]);
  assert.equal(release.synthetic_input_count, 3);
  assert.throws(() => publishEvidenceRelease(release, {
    confirmed: true,
    publishedBy: syntheticReviewer,
    publishedAt: "2026-08-19T12:31:00+08:00",
  }), /EVIDENCE_RELEASE_NOT_PUBLISHABLE/);
  assert.throws(() => createEvidenceRollbackPlan({
    fromRelease: release,
    toRelease: release,
    reasonCode: "release_error",
    requestedBy: syntheticReviewer,
    requestedAt: "2026-08-19T12:32:00+08:00",
  }), /EVIDENCE_ROLLBACK_NOT_ALLOWED/);
});

test("keeps unresolved conflict and candidate reviews as deterministic release blockers", () => {
  const fixture = syntheticCandidateState();
  const [first] = fixture.state.candidates;
  const decisions = [decision("candidate", first, "candidate_approved", "candidate_source_supported")];
  const release = createEvidenceReleaseDraft({
    evidenceVersion: "v1.0.0-fixture.2",
    pipelineState: fixture.pipeline,
    candidateState: fixture.state,
    reviewDecisions: decisions,
    inputMode: "synthetic_fixture",
    createdBy: syntheticReviewer,
    createdAt: "2026-08-19T13:00:00+08:00",
  });
  assert.ok(release.blocking_codes.includes("PENDING_CANDIDATE_REVIEW"));
  assert.ok(release.blocking_codes.includes("SOURCE_REVIEW_REQUIRED"));
  assert.ok(release.blocking_codes.includes("UNRESOLVED_DEDUPLICATION"));
  assert.ok(release.blocking_codes.includes("UNRESOLVED_CONFLICT"));
  assert.ok(release.blocking_codes.includes("SYNTHETIC_INPUT_FORBIDDEN"));
  assert.equal(release.publish_ready, false);
});
