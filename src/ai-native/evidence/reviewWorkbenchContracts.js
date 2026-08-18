import Ajv from "ajv";

export const EVIDENCE_REVIEW_SCHEMA_VERSION = "1.0.0";

const datePattern = "^\\d{4}-\\d{2}-\\d{2}$";
const dateTimePattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$";
const reviewerIdPattern = "^reviewer-[a-z0-9]+(?:-[a-z0-9]+)*$";
const candidateIdPattern = "^cand-[a-f0-9]{16}$";
const decisionIdPattern = "^review-[a-f0-9]{16}$";
const releaseIdPattern = "^release-[a-f0-9]{16}$";
const rollbackIdPattern = "^rollback-[a-f0-9]{16}$";
const nullableDate = { type: ["string", "null"], pattern: datePattern };
const nullableDateTime = { type: ["string", "null"], pattern: dateTimePattern };
const nullableCandidateId = { type: ["string", "null"], pattern: candidateIdPattern };

export const REVIEW_OUTCOMES = Object.freeze({
  source: Object.freeze(["source_confirmed", "source_manual_only", "source_blocked", "source_retired"]),
  candidate: Object.freeze(["candidate_approved", "candidate_rejected", "candidate_needs_changes"]),
  deduplication_cluster: Object.freeze(["duplicates_merge", "duplicates_keep_separate", "duplicates_needs_changes"]),
  conflict: Object.freeze([
    "conflict_keep_candidate",
    "conflict_keep_existing",
    "conflict_reject_all",
    "conflict_unresolved",
  ]),
});

export const REVIEW_REASON_CODES = Object.freeze([
  "source_current",
  "source_terms_pending",
  "source_permission_unclear",
  "source_withdrawn",
  "candidate_source_supported",
  "candidate_source_unsupported",
  "candidate_identity_unclear",
  "candidate_attribute_incorrect",
  "duplicate_exact_match",
  "duplicate_distinct_observation",
  "conflict_newer_supported",
  "conflict_existing_still_authoritative",
  "conflict_insufficient_evidence",
  "conflict_all_candidates_invalid",
]);

export const reviewDecisionSchema = {
  $id: "https://quietlens.local/schema/evidence-review-decision-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidenceReviewDecision",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "decision_id",
    "subject_type",
    "subject_id",
    "review_context",
    "outcome",
    "selected_candidate_id",
    "reason_code",
    "reviewer_kind",
    "reviewer_id",
    "reviewed_at",
    "next_review_due_at",
    "requires_human_review",
    "ai_is_reviewer",
  ],
  properties: {
    schema_version: { const: EVIDENCE_REVIEW_SCHEMA_VERSION },
    decision_id: { type: "string", pattern: decisionIdPattern },
    subject_type: { enum: Object.keys(REVIEW_OUTCOMES) },
    subject_id: { type: "string", pattern: "^(?:src-[a-z0-9]+(?:-[a-z0-9]+)*|cand-[a-f0-9]{16}|dedup-[a-f0-9]{16}|conflict-[a-f0-9]{16})$" },
    review_context: { enum: ["synthetic_fixture", "production"] },
    outcome: { enum: Object.values(REVIEW_OUTCOMES).flat() },
    selected_candidate_id: nullableCandidateId,
    reason_code: { enum: REVIEW_REASON_CODES },
    reviewer_kind: { const: "human" },
    reviewer_id: { type: "string", pattern: reviewerIdPattern },
    reviewed_at: { type: "string", pattern: dateTimePattern },
    next_review_due_at: nullableDate,
    requires_human_review: { const: true },
    ai_is_reviewer: { const: false },
  },
};

export const evidenceReleaseSchema = {
  $id: "https://quietlens.local/schema/evidence-release-record-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidenceReleaseRecord",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "release_id",
    "evidence_version",
    "input_mode",
    "included_candidate_ids",
    "review_decision_ids",
    "created_by",
    "created_at",
    "status",
    "publish_ready",
    "blocking_codes",
    "published_at",
    "published_by",
    "synthetic_input_count",
    "requires_human_publish",
    "ai_is_factual_source",
  ],
  properties: {
    schema_version: { const: EVIDENCE_REVIEW_SCHEMA_VERSION },
    release_id: { type: "string", pattern: releaseIdPattern },
    evidence_version: { type: "string", pattern: "^v\\d+\\.\\d+\\.\\d+(?:-[a-z0-9.]+)?$" },
    input_mode: { enum: ["synthetic_fixture", "production"] },
    included_candidate_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: candidateIdPattern } },
    review_decision_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: decisionIdPattern } },
    created_by: { type: "string", pattern: reviewerIdPattern },
    created_at: { type: "string", pattern: dateTimePattern },
    status: { enum: ["draft", "published"] },
    publish_ready: { type: "boolean" },
    blocking_codes: {
      type: "array",
      uniqueItems: true,
      items: {
        enum: [
          "NO_APPROVED_CANDIDATES",
          "SYNTHETIC_INPUT_FORBIDDEN",
          "SOURCE_REVIEW_REQUIRED",
          "PENDING_CANDIDATE_REVIEW",
          "UNRESOLVED_DEDUPLICATION",
          "UNRESOLVED_CONFLICT",
        ],
      },
    },
    published_at: nullableDateTime,
    published_by: { type: ["string", "null"], pattern: reviewerIdPattern },
    synthetic_input_count: { type: "integer", minimum: 0 },
    requires_human_publish: { const: true },
    ai_is_factual_source: { const: false },
  },
  allOf: [
    {
      if: { properties: { status: { const: "published" } } },
      then: {
        properties: {
          publish_ready: { const: true },
          blocking_codes: { type: "array", maxItems: 0 },
          published_at: { type: "string", pattern: dateTimePattern },
          published_by: { type: "string", pattern: reviewerIdPattern },
          synthetic_input_count: { const: 0 },
        },
      },
      else: {
        properties: {
          published_at: { type: "null" },
          published_by: { type: "null" },
        },
      },
    },
  ],
};

export const evidenceRollbackSchema = {
  $id: "https://quietlens.local/schema/evidence-rollback-record-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidenceRollbackRecord",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "rollback_id",
    "from_release_id",
    "to_release_id",
    "reason_code",
    "requested_by",
    "requested_at",
    "status",
    "requires_human_confirmation",
  ],
  properties: {
    schema_version: { const: EVIDENCE_REVIEW_SCHEMA_VERSION },
    rollback_id: { type: "string", pattern: rollbackIdPattern },
    from_release_id: { type: "string", pattern: releaseIdPattern },
    to_release_id: { type: "string", pattern: releaseIdPattern },
    reason_code: { enum: ["release_error", "source_withdrawn", "permission_revoked", "evidence_superseded"] },
    requested_by: { type: "string", pattern: reviewerIdPattern },
    requested_at: { type: "string", pattern: dateTimePattern },
    status: { const: "pending_confirmation" },
    requires_human_confirmation: { const: true },
  },
};

export const EVIDENCE_REVIEW_SCHEMAS = Object.freeze({
  EvidenceReviewDecision: reviewDecisionSchema,
  EvidenceReleaseRecord: evidenceReleaseSchema,
  EvidenceRollbackRecord: evidenceRollbackSchema,
});

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = new Map(
  Object.entries(EVIDENCE_REVIEW_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]),
);

function normalizeErrors(errors = []) {
  return errors.map((error) => ({
    instance_path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
}

export function validateReviewContract(name, value) {
  const validator = validators.get(name);
  if (!validator) throw new Error(`Unknown QuietLens review contract: ${name}`);
  const valid = validator(value);
  return { valid: Boolean(valid), errors: valid ? [] : normalizeErrors(validator.errors) };
}

export function assertReviewContract(name, value, label = name) {
  const result = validateReviewContract(name, value);
  if (!result.valid) {
    const detail = result.errors.map((error) => `${error.instance_path} ${error.message}`).join("; ");
    throw new Error(`${label} failed ${name} validation: ${detail}`);
  }
  return value;
}
