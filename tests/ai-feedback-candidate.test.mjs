import assert from "node:assert/strict";
import test from "node:test";

import {
  activeFeedbackCandidates,
  confirmFeedbackPreview,
  createFeedbackConfirmationPreview,
  deleteFeedbackRecord,
  withdrawFeedbackCandidate,
} from "../src/ai-native/evidence/feedbackCandidate.js";
import { validateFeedbackCandidateContract } from "../src/ai-native/evidence/feedbackCandidateContracts.js";
import { buildEvidenceReviewWorkbench } from "../src/ai-native/evidence/reviewWorkbench.js";
import worker from "../worker/index.js";

function preview(overrides = {}) {
  return createFeedbackConfirmationPreview({
    requestId: "req-feedback-synthetic-001",
    placeId: "hp-east-sea",
    destination: "evidence_candidate",
    feedbackText: "本地合成反馈：周三两点靠窗很亮，但三点后团队聊天变多。",
    visitWindow: "合成时段 周三 14:00–16:00",
    suggestedObservations: [
      {
        attribute: "daylight",
        summary_untrusted: "合成观察：14:00 靠窗区域明亮。",
        normalized_value: "bright_near_window",
        observed_at: "2026-08-19T14:00:00+08:00",
        applicable_time: "14:00 左右",
      },
      {
        attribute: "noise",
        summary_untrusted: "合成观察：15:00 后团队交谈增多。",
        normalized_value: "group_conversation_increased",
        observed_at: "2026-08-19T15:00:00+08:00",
        applicable_time: "15:00 后",
      },
    ],
    extractionMethod: "ai_assisted",
    extractionModel: "synthetic-feedback-extractor-v1",
    createdAt: "2026-08-19T16:00:00+08:00",
    containsPersonalIdentifiers: false,
    ...overrides,
  });
}

function confirmedCandidate(overrides = {}) {
  return confirmFeedbackPreview(preview(overrides), {
    confirmed: true,
    confirmedAt: "2026-08-19T16:01:00+08:00",
  });
}

function emptyPipelineState() {
  return { registry: [] };
}

test("keeps raw feedback only in an ephemeral confirmation preview", () => {
  const value = preview();
  assert.equal(value.status, "awaiting_user_confirmation");
  assert.equal(value.storage_scope, "ephemeral_session");
  assert.equal(value.raw_text_persisted, false);
  assert.equal(value.suggested_observations.length, 2);
  assert.throws(() => confirmFeedbackPreview(value, {
    confirmed: false,
    confirmedAt: "2026-08-19T16:01:00+08:00",
  }), /FEEDBACK_USER_CONFIRMATION_REQUIRED/);
});

test("records the session-only choice without creating an evidence-review candidate", () => {
  const record = confirmFeedbackPreview(preview({ destination: "session_only" }), {
    confirmed: true,
    confirmedAt: "2026-08-19T16:01:00+08:00",
  });
  assert.equal(record.status, "session_recorded");
  assert.equal(record.eligible_for_evidence_review, false);
  assert.equal(record.raw_text_stored, false);
  assert.equal("feedback_text_untrusted" in record, false);

  const workbench = buildEvidenceReviewWorkbench({
    pipelineState: emptyPipelineState(),
    candidateState: {
      candidates: [],
      feedback_candidates: [],
      deduplication_clusters: [],
      conflict_queue: [],
    },
    reviewDecisions: [],
    reviewContext: "synthetic_fixture",
    today: "2026-08-19",
  });
  assert.equal(workbench.metrics.feedback_candidate_pending_count, 0);
});

test("creates only a pending untrusted feedback candidate after explicit confirmation", () => {
  const candidate = confirmedCandidate();
  assert.equal(candidate.status, "pending_review");
  assert.equal(candidate.review_status, "pending");
  assert.equal(candidate.user_confirmed, true);
  assert.equal(candidate.requires_human_review, true);
  assert.equal(candidate.content_trust, "untrusted");
  assert.equal(candidate.ai_is_factual_source, false);
  assert.equal(candidate.raw_text_stored, false);
  assert.equal("feedback_text_untrusted" in candidate, false);
  assert.ok(candidate.observations.every((item) => item.user_confirmed && !item.independently_verified));
});

test("puts a confirmed feedback candidate in the review queue without making it publishable evidence", () => {
  const candidate = confirmedCandidate();
  const workbench = buildEvidenceReviewWorkbench({
    pipelineState: emptyPipelineState(),
    candidateState: {
      candidates: [],
      feedback_candidates: [candidate],
      deduplication_clusters: [],
      conflict_queue: [],
    },
    reviewDecisions: [],
    reviewContext: "synthetic_fixture",
    today: "2026-08-19",
  });
  assert.equal(workbench.metrics.feedback_candidate_pending_count, 1);
  assert.equal(workbench.queue[0].subject_type, "feedback_candidate");
  assert.equal(workbench.queue[0].reason, "feedback_candidate_pending");
  assert.equal(workbench.queue[0].content_trust, "untrusted");
});

test("withdraws a pending candidate and removes it from the active review queue", () => {
  const candidate = confirmedCandidate();
  assert.throws(() => withdrawFeedbackCandidate(candidate, {
    confirmed: false,
    withdrawnAt: "2026-08-19T17:00:00+08:00",
  }), /FEEDBACK_WITHDRAWAL_CONFIRMATION_REQUIRED/);
  const withdrawn = withdrawFeedbackCandidate(candidate, {
    confirmed: true,
    withdrawnAt: "2026-08-19T17:00:00+08:00",
  });
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.review_status, "withdrawn");
  assert.deepEqual(activeFeedbackCandidates([candidate, withdrawn]), [candidate]);

  const workbench = buildEvidenceReviewWorkbench({
    pipelineState: emptyPipelineState(),
    candidateState: {
      candidates: [],
      feedback_candidates: [withdrawn],
      deduplication_clusters: [],
      conflict_queue: [],
    },
    reviewDecisions: [],
    reviewContext: "synthetic_fixture",
    today: "2026-08-19",
  });
  assert.equal(workbench.metrics.feedback_candidate_pending_count, 0);
});

test("deletes previews and session records but requires candidate withdrawal first", () => {
  const draft = preview();
  const sessionRecord = confirmFeedbackPreview(preview({ destination: "session_only" }), {
    confirmed: true,
    confirmedAt: "2026-08-19T16:01:00+08:00",
  });
  const candidate = confirmedCandidate();
  assert.equal(deleteFeedbackRecord(draft, {
    confirmed: true,
    deletedAt: "2026-08-19T17:00:00+08:00",
  }).target_type, "confirmation_preview");
  assert.equal(deleteFeedbackRecord(sessionRecord, {
    confirmed: true,
    deletedAt: "2026-08-19T17:00:00+08:00",
  }).target_type, "session_record");
  assert.throws(() => deleteFeedbackRecord(candidate, {
    confirmed: true,
    deletedAt: "2026-08-19T17:00:00+08:00",
  }), /FEEDBACK_CANDIDATE_WITHDRAWAL_REQUIRED/);
  const withdrawn = withdrawFeedbackCandidate(candidate, {
    confirmed: true,
    withdrawnAt: "2026-08-19T17:00:00+08:00",
  });
  const receipt = deleteFeedbackRecord(withdrawn, {
    confirmed: true,
    deletedAt: "2026-08-19T17:01:00+08:00",
  });
  assert.equal(receipt.target_type, "withdrawn_candidate");
  assert.equal(receipt.content_removed, true);
  assert.equal("observations" in receipt, false);
});

test("rejects common personal identifiers before a preview is created", () => {
  assert.throws(() => preview({
    feedbackText: "请联系 13800138000，我下午去过。",
  }), /FEEDBACK_PERSONAL_IDENTIFIERS_FORBIDDEN/);
  assert.throws(() => preview({
    feedbackText: "普通合成内容",
    containsPersonalIdentifiers: true,
  }), /FEEDBACK_PERSONAL_IDENTIFIERS_FORBIDDEN/);
});

test("contract rejects attempts to label a feedback candidate as verified or published", () => {
  const candidate = confirmedCandidate();
  assert.equal(validateFeedbackCandidateContract("FeedbackCandidateRecord", {
    ...candidate,
    status: "published",
  }).valid, false);
  assert.equal(validateFeedbackCandidateContract("FeedbackCandidateRecord", {
    ...candidate,
    ai_is_factual_source: true,
  }).valid, false);
  assert.equal(validateFeedbackCandidateContract("FeedbackCandidateRecord", {
    ...candidate,
    observations: candidate.observations.map((item) => ({ ...item, independently_verified: true })),
  }).valid, false);
});

test("keeps the production feedback API absent", async () => {
  const response = await worker.fetch(new Request("https://quietlens.test/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedback: "synthetic" }),
  }), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: "API_NOT_FOUND" } });
});
