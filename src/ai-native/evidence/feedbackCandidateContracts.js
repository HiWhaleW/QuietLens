import Ajv from "ajv";

export const FEEDBACK_CANDIDATE_SCHEMA_VERSION = "1.0.0";

export const FEEDBACK_ATTRIBUTES = Object.freeze([
  "operating_status",
  "workspace",
  "daylight",
  "seating",
  "outlets",
  "outdoor_seating",
  "noise",
  "crowding",
  "call_environment",
]);

const dateTimePattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$";
const requestIdPattern = "^req-[a-z0-9]+(?:-[a-z0-9]+)*$";
const placeIdPattern = "^hp-[a-z0-9]+(?:-[a-z0-9]+)*$";
const previewIdPattern = "^feedback-preview-[a-f0-9]{16}$";
const feedbackCandidateIdPattern = "^feedback-cand-[a-f0-9]{16}$";
const sessionRecordIdPattern = "^feedback-session-[a-f0-9]{16}$";
const observationIdPattern = "^feedback-obs-[a-f0-9]{16}$";
const deletionReceiptIdPattern = "^feedback-delete-[a-f0-9]{16}$";
const normalizedValue = { type: ["string", "number", "boolean", "array", "null"] };

const observationSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "observation_id",
    "attribute",
    "summary_untrusted",
    "normalized_value",
    "observed_at",
    "applicable_time",
    "user_confirmed",
    "independently_verified",
    "content_trust",
  ],
  properties: {
    observation_id: { type: "string", pattern: observationIdPattern },
    attribute: { enum: FEEDBACK_ATTRIBUTES },
    summary_untrusted: { type: "string", minLength: 1, maxLength: 180 },
    normalized_value: normalizedValue,
    observed_at: { type: ["string", "null"], pattern: dateTimePattern },
    applicable_time: { type: ["string", "null"], minLength: 1, maxLength: 120 },
    user_confirmed: { const: true },
    independently_verified: { const: false },
    content_trust: { const: "untrusted" },
  },
};

export const feedbackConfirmationPreviewSchema = {
  $id: "https://quietlens.local/schema/feedback-confirmation-preview-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "FeedbackConfirmationPreview",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "preview_id",
    "request_id",
    "place_id",
    "destination",
    "feedback_text_untrusted",
    "visit_window",
    "suggested_observations",
    "extraction_method",
    "extraction_model",
    "created_at",
    "status",
    "storage_scope",
    "raw_text_persisted",
    "contains_personal_identifiers",
    "ai_is_factual_source",
  ],
  properties: {
    schema_version: { const: FEEDBACK_CANDIDATE_SCHEMA_VERSION },
    preview_id: { type: "string", pattern: previewIdPattern },
    request_id: { type: "string", pattern: requestIdPattern },
    place_id: { type: "string", pattern: placeIdPattern },
    destination: { enum: ["session_only", "evidence_candidate"] },
    feedback_text_untrusted: { type: "string", minLength: 1, maxLength: 500 },
    visit_window: { type: ["string", "null"], minLength: 1, maxLength: 120 },
    suggested_observations: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["attribute", "summary_untrusted", "normalized_value", "observed_at", "applicable_time"],
        properties: {
          attribute: { enum: FEEDBACK_ATTRIBUTES },
          summary_untrusted: { type: "string", minLength: 1, maxLength: 180 },
          normalized_value: normalizedValue,
          observed_at: { type: ["string", "null"], pattern: dateTimePattern },
          applicable_time: { type: ["string", "null"], minLength: 1, maxLength: 120 },
        },
      },
    },
    extraction_method: { enum: ["manual", "ai_assisted"] },
    extraction_model: { type: ["string", "null"], minLength: 1, maxLength: 120 },
    created_at: { type: "string", pattern: dateTimePattern },
    status: { const: "awaiting_user_confirmation" },
    storage_scope: { const: "ephemeral_session" },
    raw_text_persisted: { const: false },
    contains_personal_identifiers: { const: false },
    ai_is_factual_source: { const: false },
  },
  allOf: [
    {
      if: { properties: { extraction_method: { const: "ai_assisted" } } },
      then: { properties: { extraction_model: { type: "string", minLength: 1 } } },
      else: { properties: { extraction_model: { type: "null" } } },
    },
  ],
};

export const feedbackCandidateRecordSchema = {
  $id: "https://quietlens.local/schema/feedback-candidate-record-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "FeedbackCandidateRecord",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "feedback_candidate_id",
    "request_id",
    "place_id",
    "observations",
    "visit_window",
    "submitted_at",
    "withdrawn_at",
    "status",
    "review_status",
    "user_confirmed",
    "requires_human_review",
    "content_trust",
    "raw_text_stored",
    "contains_personal_identifiers",
    "ai_is_factual_source",
  ],
  properties: {
    schema_version: { const: FEEDBACK_CANDIDATE_SCHEMA_VERSION },
    feedback_candidate_id: { type: "string", pattern: feedbackCandidateIdPattern },
    request_id: { type: "string", pattern: requestIdPattern },
    place_id: { type: "string", pattern: placeIdPattern },
    observations: { type: "array", minItems: 1, maxItems: 6, items: observationSchema },
    visit_window: { type: ["string", "null"], minLength: 1, maxLength: 120 },
    submitted_at: { type: "string", pattern: dateTimePattern },
    withdrawn_at: { type: ["string", "null"], pattern: dateTimePattern },
    status: { enum: ["pending_review", "withdrawn"] },
    review_status: { enum: ["pending", "withdrawn"] },
    user_confirmed: { const: true },
    requires_human_review: { const: true },
    content_trust: { const: "untrusted" },
    raw_text_stored: { const: false },
    contains_personal_identifiers: { const: false },
    ai_is_factual_source: { const: false },
  },
  allOf: [
    {
      if: { properties: { status: { const: "withdrawn" } } },
      then: {
        properties: {
          review_status: { const: "withdrawn" },
          withdrawn_at: { type: "string", pattern: dateTimePattern },
        },
      },
      else: {
        properties: {
          review_status: { const: "pending" },
          withdrawn_at: { type: "null" },
        },
      },
    },
  ],
};

export const feedbackSessionRecordSchema = {
  $id: "https://quietlens.local/schema/feedback-session-record-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "FeedbackSessionRecord",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "session_record_id",
    "request_id",
    "place_id",
    "observations",
    "visit_window",
    "confirmed_at",
    "status",
    "storage_scope",
    "eligible_for_evidence_review",
    "raw_text_stored",
    "contains_personal_identifiers",
    "ai_is_factual_source",
  ],
  properties: {
    schema_version: { const: FEEDBACK_CANDIDATE_SCHEMA_VERSION },
    session_record_id: { type: "string", pattern: sessionRecordIdPattern },
    request_id: { type: "string", pattern: requestIdPattern },
    place_id: { type: "string", pattern: placeIdPattern },
    observations: { type: "array", minItems: 1, maxItems: 6, items: observationSchema },
    visit_window: { type: ["string", "null"], minLength: 1, maxLength: 120 },
    confirmed_at: { type: "string", pattern: dateTimePattern },
    status: { const: "session_recorded" },
    storage_scope: { const: "ephemeral_session" },
    eligible_for_evidence_review: { const: false },
    raw_text_stored: { const: false },
    contains_personal_identifiers: { const: false },
    ai_is_factual_source: { const: false },
  },
};

export const feedbackDeletionReceiptSchema = {
  $id: "https://quietlens.local/schema/feedback-deletion-receipt-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "FeedbackDeletionReceipt",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "deletion_receipt_id", "target_type", "target_id", "deleted_at", "content_removed"],
  properties: {
    schema_version: { const: FEEDBACK_CANDIDATE_SCHEMA_VERSION },
    deletion_receipt_id: { type: "string", pattern: deletionReceiptIdPattern },
    target_type: { enum: ["confirmation_preview", "session_record", "withdrawn_candidate"] },
    target_id: { type: "string", minLength: 1, maxLength: 80 },
    deleted_at: { type: "string", pattern: dateTimePattern },
    content_removed: { const: true },
  },
};

export const FEEDBACK_CANDIDATE_SCHEMAS = Object.freeze({
  FeedbackConfirmationPreview: feedbackConfirmationPreviewSchema,
  FeedbackCandidateRecord: feedbackCandidateRecordSchema,
  FeedbackSessionRecord: feedbackSessionRecordSchema,
  FeedbackDeletionReceipt: feedbackDeletionReceiptSchema,
});

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = new Map(
  Object.entries(FEEDBACK_CANDIDATE_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]),
);

function normalizeErrors(errors = []) {
  return errors.map((error) => ({
    instance_path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
}

export function validateFeedbackCandidateContract(name, value) {
  const validator = validators.get(name);
  if (!validator) throw new Error(`Unknown QuietLens feedback contract: ${name}`);
  const valid = validator(value);
  return { valid: Boolean(valid), errors: valid ? [] : normalizeErrors(validator.errors) };
}

export function assertFeedbackCandidateContract(name, value, label = name) {
  const result = validateFeedbackCandidateContract(name, value);
  if (!result.valid) {
    const detail = result.errors.map((error) => `${error.instance_path} ${error.message}`).join("; ");
    throw new Error(`${label} failed ${name} validation: ${detail}`);
  }
  return value;
}
