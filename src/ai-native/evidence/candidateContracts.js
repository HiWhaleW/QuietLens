import Ajv from "ajv";

import { EVIDENCE_ATTRIBUTES } from "../contracts/schemas.js";
import { SOURCE_FAMILY_POLICIES } from "./sourceAccessPolicy.js";

export const CANDIDATE_PIPELINE_SCHEMA_VERSION = "1.0.0";

const dateTimePattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$";
const sourceIdPattern = "^src-[a-z0-9]+(?:-[a-z0-9]+)*$";
const placeIdPattern = "^hp-[a-z0-9]+(?:-[a-z0-9]+)*$";
const candidateIdPattern = "^cand-[a-f0-9]{16}$";
const clusterIdPattern = "^dedup-[a-f0-9]{16}$";
const conflictIdPattern = "^conflict-[a-f0-9]{16}$";
const fingerprintPattern = "^[a-f0-9]{64}$";
const nullableDateTime = { type: ["string", "null"], pattern: dateTimePattern };
const normalizedValue = { type: ["string", "number", "boolean", "array", "null"] };

export const candidateEvidenceRecordSchema = {
  $id: "https://quietlens.local/schema/candidate-evidence-record-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "CandidateEvidenceRecord",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "candidate_id",
    "snapshot_id",
    "source_id",
    "source_type",
    "place_id",
    "place_match",
    "attribute",
    "source_excerpt_untrusted",
    "normalized_value",
    "observed_at",
    "published_at",
    "applicable_time",
    "extraction_method",
    "extraction_model",
    "content_fingerprint",
    "status",
    "review_status",
    "risk_flags",
    "contains_personal_identifiers",
    "ai_is_factual_source",
  ],
  properties: {
    schema_version: { const: CANDIDATE_PIPELINE_SCHEMA_VERSION },
    candidate_id: { type: "string", pattern: candidateIdPattern },
    snapshot_id: { type: "string", pattern: "^snap-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    source_id: { type: "string", pattern: sourceIdPattern },
    source_type: { enum: Object.keys(SOURCE_FAMILY_POLICIES) },
    place_id: { type: ["string", "null"], pattern: placeIdPattern },
    place_match: {
      type: "object",
      additionalProperties: false,
      required: ["status", "method", "candidate_place_ids", "confidence", "requires_human_review"],
      properties: {
        status: { enum: ["matched", "ambiguous", "unmatched"] },
        method: { enum: ["exact_id", "exact_alias", "source_scope", "none"] },
        candidate_place_ids: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", pattern: placeIdPattern },
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        requires_human_review: { const: true },
      },
    },
    attribute: { enum: EVIDENCE_ATTRIBUTES },
    source_excerpt_untrusted: { type: "string", minLength: 1, maxLength: 500 },
    normalized_value: normalizedValue,
    observed_at: nullableDateTime,
    published_at: nullableDateTime,
    applicable_time: { type: ["string", "null"], minLength: 1, maxLength: 120 },
    extraction_method: { enum: ["deterministic", "manual", "ai_assisted"] },
    extraction_model: { type: ["string", "null"], minLength: 1, maxLength: 120 },
    content_fingerprint: { type: "string", pattern: fingerprintPattern },
    status: { const: "candidate" },
    review_status: { const: "pending" },
    risk_flags: {
      type: "array",
      uniqueItems: true,
      items: {
        enum: [
          "ai_extracted",
          "identity_ambiguous",
          "place_unmatched",
          "prompt_injection_text",
          "traceable_ugc",
        ],
      },
    },
    contains_personal_identifiers: { const: false },
    ai_is_factual_source: { const: false },
  },
  allOf: [
    {
      if: { properties: { extraction_method: { const: "ai_assisted" } } },
      then: { properties: { extraction_model: { type: "string", minLength: 1 } } },
      else: { properties: { extraction_model: { type: "null" } } },
    },
    {
      if: {
        properties: {
          place_match: {
            type: "object",
            properties: { status: { const: "matched" } },
          },
        },
      },
      then: { properties: { place_id: { type: "string", pattern: placeIdPattern } } },
      else: { properties: { place_id: { type: "null" } } },
    },
  ],
};

export const deduplicationClusterSchema = {
  $id: "https://quietlens.local/schema/deduplication-cluster-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "DeduplicationCluster",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "cluster_id",
    "content_fingerprint",
    "candidate_ids",
    "source_ids",
    "place_id",
    "attribute",
    "status",
    "review_status",
    "requires_human_review",
  ],
  properties: {
    schema_version: { const: CANDIDATE_PIPELINE_SCHEMA_VERSION },
    cluster_id: { type: "string", pattern: clusterIdPattern },
    content_fingerprint: { type: "string", pattern: fingerprintPattern },
    candidate_ids: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", pattern: candidateIdPattern } },
    source_ids: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: sourceIdPattern } },
    place_id: { type: ["string", "null"], pattern: placeIdPattern },
    attribute: { enum: EVIDENCE_ATTRIBUTES },
    status: { const: "duplicate_cluster" },
    review_status: { const: "pending" },
    requires_human_review: { const: true },
  },
};

export const conflictQueueItemSchema = {
  $id: "https://quietlens.local/schema/conflict-queue-item-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ConflictQueueItem",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "conflict_id",
    "place_id",
    "attribute",
    "candidate_ids",
    "reason",
    "severity",
    "comparison_scope",
    "status",
    "requires_human_review",
  ],
  properties: {
    schema_version: { const: CANDIDATE_PIPELINE_SCHEMA_VERSION },
    conflict_id: { type: "string", pattern: conflictIdPattern },
    place_id: { type: "string", pattern: placeIdPattern },
    attribute: { enum: EVIDENCE_ATTRIBUTES },
    candidate_ids: { type: "array", minItems: 2, uniqueItems: true, items: { type: "string", pattern: candidateIdPattern } },
    reason: { const: "normalized_value_disagreement" },
    severity: { enum: ["high", "medium"] },
    comparison_scope: { enum: ["same_time_scope", "time_scope_review"] },
    status: { const: "pending_review" },
    requires_human_review: { const: true },
  },
};

export const CANDIDATE_PIPELINE_SCHEMAS = Object.freeze({
  CandidateEvidenceRecord: candidateEvidenceRecordSchema,
  DeduplicationCluster: deduplicationClusterSchema,
  ConflictQueueItem: conflictQueueItemSchema,
});

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = new Map(
  Object.entries(CANDIDATE_PIPELINE_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]),
);

function normalizeErrors(errors = []) {
  return errors.map((error) => ({
    instance_path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
}

export function validateCandidateContract(name, value) {
  const validator = validators.get(name);
  if (!validator) throw new Error(`Unknown QuietLens candidate contract: ${name}`);
  const valid = validator(value);
  return { valid: Boolean(valid), errors: valid ? [] : normalizeErrors(validator.errors) };
}

export function assertCandidateContract(name, value, label = name) {
  const result = validateCandidateContract(name, value);
  if (!result.valid) {
    const detail = result.errors.map((error) => `${error.instance_path} ${error.message}`).join("; ");
    throw new Error(`${label} failed ${name} validation: ${detail}`);
  }
  return value;
}
