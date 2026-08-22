import {
  FEEDBACK_CANDIDATE_SCHEMA_VERSION,
  assertFeedbackCandidateContract,
} from "./feedbackCandidateContracts.js";
import { stableHexId } from "./stableId.js";

const PERSONAL_IDENTIFIER_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:\+?86[-\s]?)?1[3-9]\d{9}/u,
  /(?:微信|wechat|wx)\s*[:：]?\s*[a-zA-Z][-_a-zA-Z0-9]{5,19}/iu,
];

function assertDateTime(value, code) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(code);
}

function hasPersonalIdentifier(value) {
  return PERSONAL_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(value));
}

function observationId(preview, observation, index) {
  return `feedback-obs-${stableHexId([
    preview.preview_id,
    index,
    observation.attribute,
    observation.summary_untrusted,
    JSON.stringify(observation.normalized_value),
  ].join("|"))}`;
}

function confirmedObservations(preview) {
  return preview.suggested_observations.map((observation, index) => ({
    observation_id: observationId(preview, observation, index),
    ...observation,
    user_confirmed: true,
    independently_verified: false,
    content_trust: "untrusted",
  }));
}

export function createFeedbackConfirmationPreview({
  requestId,
  placeId,
  destination,
  feedbackText,
  visitWindow = null,
  suggestedObservations,
  extractionMethod,
  extractionModel = null,
  createdAt,
  containsPersonalIdentifiers,
}) {
  const normalizedText = String(feedbackText ?? "").trim();
  if (containsPersonalIdentifiers !== false || hasPersonalIdentifier(normalizedText)) {
    throw new Error("FEEDBACK_PERSONAL_IDENTIFIERS_FORBIDDEN");
  }
  assertDateTime(createdAt, "FEEDBACK_CREATED_AT_INVALID");
  const preview = {
    schema_version: FEEDBACK_CANDIDATE_SCHEMA_VERSION,
    preview_id: `feedback-preview-${stableHexId(`${requestId}|${placeId}|${normalizedText}|${createdAt}`)}`,
    request_id: requestId,
    place_id: placeId,
    destination,
    feedback_text_untrusted: normalizedText,
    visit_window: visitWindow,
    suggested_observations: suggestedObservations,
    extraction_method: extractionMethod,
    extraction_model: extractionMethod === "ai_assisted" ? extractionModel : null,
    created_at: createdAt,
    status: "awaiting_user_confirmation",
    storage_scope: "ephemeral_session",
    raw_text_persisted: false,
    contains_personal_identifiers: false,
    ai_is_factual_source: false,
  };
  return assertFeedbackCandidateContract("FeedbackConfirmationPreview", preview, preview.preview_id);
}

export function confirmFeedbackPreview(preview, { confirmed, confirmedAt }) {
  assertFeedbackCandidateContract("FeedbackConfirmationPreview", preview, preview?.preview_id);
  if (confirmed !== true) throw new Error("FEEDBACK_USER_CONFIRMATION_REQUIRED");
  assertDateTime(confirmedAt, "FEEDBACK_CONFIRMED_AT_INVALID");
  if (Date.parse(confirmedAt) < Date.parse(preview.created_at)) throw new Error("FEEDBACK_CONFIRMATION_BEFORE_PREVIEW");
  const observations = confirmedObservations(preview);

  if (preview.destination === "session_only") {
    const record = {
      schema_version: FEEDBACK_CANDIDATE_SCHEMA_VERSION,
      session_record_id: `feedback-session-${stableHexId(`${preview.preview_id}|${confirmedAt}`)}`,
      request_id: preview.request_id,
      place_id: preview.place_id,
      observations,
      visit_window: preview.visit_window,
      confirmed_at: confirmedAt,
      status: "session_recorded",
      storage_scope: "ephemeral_session",
      eligible_for_evidence_review: false,
      raw_text_stored: false,
      contains_personal_identifiers: false,
      ai_is_factual_source: false,
    };
    return assertFeedbackCandidateContract("FeedbackSessionRecord", record, record.session_record_id);
  }

  const candidate = {
    schema_version: FEEDBACK_CANDIDATE_SCHEMA_VERSION,
    feedback_candidate_id: `feedback-cand-${stableHexId(`${preview.preview_id}|${confirmedAt}`)}`,
    request_id: preview.request_id,
    place_id: preview.place_id,
    observations,
    visit_window: preview.visit_window,
    submitted_at: confirmedAt,
    withdrawn_at: null,
    status: "pending_review",
    review_status: "pending",
    user_confirmed: true,
    requires_human_review: true,
    content_trust: "untrusted",
    raw_text_stored: false,
    contains_personal_identifiers: false,
    ai_is_factual_source: false,
  };
  return assertFeedbackCandidateContract("FeedbackCandidateRecord", candidate, candidate.feedback_candidate_id);
}

export function withdrawFeedbackCandidate(candidate, { confirmed, withdrawnAt }) {
  assertFeedbackCandidateContract("FeedbackCandidateRecord", candidate, candidate?.feedback_candidate_id);
  if (confirmed !== true) throw new Error("FEEDBACK_WITHDRAWAL_CONFIRMATION_REQUIRED");
  if (candidate.status !== "pending_review") throw new Error("FEEDBACK_CANDIDATE_NOT_WITHDRAWABLE");
  assertDateTime(withdrawnAt, "FEEDBACK_WITHDRAWN_AT_INVALID");
  if (Date.parse(withdrawnAt) < Date.parse(candidate.submitted_at)) throw new Error("FEEDBACK_WITHDRAWAL_BEFORE_SUBMISSION");
  return assertFeedbackCandidateContract("FeedbackCandidateRecord", {
    ...candidate,
    status: "withdrawn",
    review_status: "withdrawn",
    withdrawn_at: withdrawnAt,
  }, candidate.feedback_candidate_id);
}

export function deleteFeedbackRecord(record, { confirmed, deletedAt }) {
  if (confirmed !== true) throw new Error("FEEDBACK_DELETION_CONFIRMATION_REQUIRED");
  assertDateTime(deletedAt, "FEEDBACK_DELETED_AT_INVALID");
  let targetType;
  let targetId;
  if (record?.preview_id) {
    assertFeedbackCandidateContract("FeedbackConfirmationPreview", record, record.preview_id);
    targetType = "confirmation_preview";
    targetId = record.preview_id;
  } else if (record?.session_record_id) {
    assertFeedbackCandidateContract("FeedbackSessionRecord", record, record.session_record_id);
    targetType = "session_record";
    targetId = record.session_record_id;
  } else if (record?.feedback_candidate_id) {
    assertFeedbackCandidateContract("FeedbackCandidateRecord", record, record.feedback_candidate_id);
    if (record.status !== "withdrawn") throw new Error("FEEDBACK_CANDIDATE_WITHDRAWAL_REQUIRED");
    targetType = "withdrawn_candidate";
    targetId = record.feedback_candidate_id;
  } else {
    throw new Error("FEEDBACK_RECORD_INVALID");
  }
  const receipt = {
    schema_version: FEEDBACK_CANDIDATE_SCHEMA_VERSION,
    deletion_receipt_id: `feedback-delete-${stableHexId(`${targetType}|${targetId}|${deletedAt}`)}`,
    target_type: targetType,
    target_id: targetId,
    deleted_at: deletedAt,
    content_removed: true,
  };
  return assertFeedbackCandidateContract("FeedbackDeletionReceipt", receipt, receipt.deletion_receipt_id);
}

export function activeFeedbackCandidates(records = []) {
  return records.filter((record) => record?.status === "pending_review");
}
