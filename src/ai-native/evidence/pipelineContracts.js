import Ajv from "ajv";

import { EVIDENCE_ATTRIBUTES } from "../contracts/schemas.js";
import { SOURCE_ACCESS_POLICY_VERSION, SOURCE_FAMILY_POLICIES } from "./sourceAccessPolicy.js";

export const EVIDENCE_PIPELINE_SCHEMA_VERSION = "1.0.0";
export const EVIDENCE_PIPELINE_TARGET_VERSION = "v1.0";

const datePattern = "^\\d{4}-\\d{2}-\\d{2}$";
const dateTimePattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$";
const sourceIdPattern = "^src-[a-z0-9]+(?:-[a-z0-9]+)*$";
const placeIdPattern = "^hp-[a-z0-9]+(?:-[a-z0-9]+)*$";
const planIdPattern = "^plan-[a-z0-9]+(?:-[a-z0-9]+)*$";
const adapterIdPattern = "^adapter-[a-z0-9]+(?:-[a-z0-9]+)*$";
const runIdPattern = "^run-[a-z0-9]+(?:-[a-z0-9]+)*$";
const snapshotIdPattern = "^snap-[a-z0-9]+(?:-[a-z0-9]+)*$";
const nullableDate = { type: ["string", "null"], pattern: datePattern };
const nullableDateTime = { type: ["string", "null"], pattern: dateTimePattern };
const sourceTypes = Object.keys(SOURCE_FAMILY_POLICIES);

export const pipelineManifestSchema = {
  $id: "https://quietlens.local/schema/evidence-pipeline-manifest-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidencePipelineManifest",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "source_access_policy_version",
    "evidence_target_version",
    "coverage_scope",
    "generated_at",
    "source_count",
    "access_plan_count",
    "run_count",
    "snapshot_count",
    "external_collection_enabled",
    "ai_is_factual_source",
  ],
  properties: {
    schema_version: { const: EVIDENCE_PIPELINE_SCHEMA_VERSION },
    source_access_policy_version: { const: SOURCE_ACCESS_POLICY_VERSION },
    evidence_target_version: { const: EVIDENCE_PIPELINE_TARGET_VERSION },
    coverage_scope: { const: "huangpu-10-v0.1" },
    generated_at: { type: "string", pattern: dateTimePattern },
    source_count: { type: "integer", minimum: 0 },
    access_plan_count: { type: "integer", minimum: 0 },
    run_count: { type: "integer", minimum: 0 },
    snapshot_count: { type: "integer", minimum: 0 },
    external_collection_enabled: { type: "boolean" },
    ai_is_factual_source: { const: false },
  },
};

export const sourceAccessPlanSchema = {
  $id: "https://quietlens.local/schema/source-access-plan-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "SourceAccessPlan",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "plan_id",
    "adapter_id",
    "source_type",
    "host",
    "access_mode",
    "enabled",
    "approval_status",
    "review",
    "controls",
    "rate_limit",
    "storage",
    "output_status",
    "stop_conditions",
  ],
  properties: {
    schema_version: { const: EVIDENCE_PIPELINE_SCHEMA_VERSION },
    plan_id: { type: "string", pattern: planIdPattern },
    adapter_id: { type: "string", pattern: adapterIdPattern },
    source_type: { enum: sourceTypes },
    host: { type: "string" },
    access_mode: {
      enum: ["official_api", "licensed_api", "public_page", "manual_research", "user_submitted_link", "internal_registry"],
    },
    enabled: { type: "boolean" },
    approval_status: { enum: ["pending", "approved", "rejected"] },
    review: {
      type: "object",
      additionalProperties: false,
      required: ["terms_reviewed_at", "robots_reviewed_at", "owner"],
      properties: {
        terms_reviewed_at: nullableDate,
        robots_reviewed_at: nullableDate,
        owner: { type: "string", minLength: 1 },
      },
    },
    controls: {
      type: "object",
      additionalProperties: false,
      required: [
        "bypass_captcha",
        "reuse_authenticated_session",
        "reverse_engineer_signature",
        "call_private_api",
        "rotate_identity_or_proxy",
        "honors_retry_after",
        "uses_cache",
      ],
      properties: {
        bypass_captcha: { const: false },
        reuse_authenticated_session: { const: false },
        reverse_engineer_signature: { const: false },
        call_private_api: { const: false },
        rotate_identity_or_proxy: { const: false },
        honors_retry_after: { type: "boolean" },
        uses_cache: { type: "boolean" },
      },
    },
    rate_limit: {
      type: "object",
      additionalProperties: false,
      required: ["requests_per_minute", "max_concurrency"],
      properties: {
        requests_per_minute: { type: "integer", minimum: 0 },
        max_concurrency: { type: "integer", minimum: 0 },
      },
    },
    storage: {
      type: "object",
      additionalProperties: false,
      required: ["stores_personal_identifiers", "stores_full_text", "raw_retention_days"],
      properties: {
        stores_personal_identifiers: { const: false },
        stores_full_text: { type: "boolean" },
        raw_retention_days: { type: "integer", minimum: 0, maximum: 365 },
      },
    },
    output_status: { const: "candidate" },
    stop_conditions: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        enum: [
          "access_challenge",
          "identity_mismatch",
          "permission_unclear",
          "rate_limited",
          "source_withdrawn",
          "terms_changed",
        ],
      },
    },
  },
};

export const sourceRegistryEntrySchema = {
  $id: "https://quietlens.local/schema/source-registry-entry-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "SourceRegistryEntry",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "source_id",
    "source_record_version",
    "source_type",
    "canonical_host",
    "collection_status",
    "access_plan_id",
    "permitted_attributes",
    "usage_restrictions",
    "owner",
    "last_reviewed_at",
    "next_review_due_at",
    "supports_place_ids",
  ],
  properties: {
    schema_version: { const: EVIDENCE_PIPELINE_SCHEMA_VERSION },
    source_id: { type: "string", pattern: sourceIdPattern },
    source_record_version: { const: "1.0.0" },
    source_type: { enum: sourceTypes },
    canonical_host: { type: ["string", "null"], minLength: 1 },
    collection_status: {
      enum: ["approved_api", "approved_public_page", "pending_review", "manual_only", "blocked_automation", "retired"],
    },
    access_plan_id: { type: ["string", "null"], pattern: planIdPattern },
    permitted_attributes: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { enum: EVIDENCE_ATTRIBUTES },
    },
    usage_restrictions: { enum: ["citation_only", "research_only", "public_reference"] },
    owner: { type: "string", minLength: 1 },
    last_reviewed_at: nullableDate,
    next_review_due_at: nullableDate,
    supports_place_ids: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: { type: "string", pattern: placeIdPattern },
    },
  },
};

export const collectionRunSchema = {
  $id: "https://quietlens.local/schema/collection-run-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "CollectionRun",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "run_id",
    "source_id",
    "access_plan_id",
    "adapter_id",
    "trigger",
    "started_at",
    "finished_at",
    "status",
    "request_count",
    "snapshot_ids",
    "error_code",
    "external_network_used",
  ],
  properties: {
    schema_version: { const: EVIDENCE_PIPELINE_SCHEMA_VERSION },
    run_id: { type: "string", pattern: runIdPattern },
    source_id: { type: "string", pattern: sourceIdPattern },
    access_plan_id: { type: "string", pattern: planIdPattern },
    adapter_id: { type: "string", pattern: adapterIdPattern },
    trigger: { enum: ["manual", "scheduled", "user_submitted"] },
    started_at: { type: "string", pattern: dateTimePattern },
    finished_at: nullableDateTime,
    status: { enum: ["running", "captured", "not_modified", "partial", "failed", "blocked"] },
    request_count: { type: "integer", minimum: 0 },
    snapshot_ids: {
      type: "array",
      uniqueItems: true,
      items: { type: "string", pattern: snapshotIdPattern },
    },
    error_code: { type: ["string", "null"], pattern: "^[A-Z][A-Z0-9_]+$" },
    external_network_used: { type: "boolean" },
  },
};

export const rawSnapshotSchema = {
  $id: "https://quietlens.local/schema/raw-snapshot-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "RawSnapshot",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "snapshot_id",
    "run_id",
    "source_id",
    "access_plan_id",
    "captured_at",
    "status",
    "source_url",
    "http_status",
    "content_type",
    "content_length",
    "content_sha256",
    "payload_ref",
    "storage_mode",
    "personal_data_status",
    "ugc_full_text_stored",
    "error_code",
    "retry_after_at",
  ],
  properties: {
    schema_version: { const: EVIDENCE_PIPELINE_SCHEMA_VERSION },
    snapshot_id: { type: "string", pattern: snapshotIdPattern },
    run_id: { type: "string", pattern: runIdPattern },
    source_id: { type: "string", pattern: sourceIdPattern },
    access_plan_id: { type: "string", pattern: planIdPattern },
    captured_at: { type: "string", pattern: dateTimePattern },
    status: { enum: ["captured", "not_modified", "failed", "blocked"] },
    source_url: { type: "string", pattern: "^(?:https?://|urn:quietlens:)" },
    http_status: { type: ["integer", "null"], minimum: 100, maximum: 599 },
    content_type: { type: ["string", "null"], minLength: 1 },
    content_length: { type: "integer", minimum: 0 },
    content_sha256: { type: ["string", "null"], pattern: "^[a-f0-9]{64}$" },
    payload_ref: { type: ["string", "null"], pattern: "^urn:quietlens:raw:[a-z0-9]+(?:-[a-z0-9]+)*$" },
    storage_mode: { enum: ["none", "metadata_excerpt", "authorized_payload"] },
    personal_data_status: { enum: ["none", "redacted"] },
    ugc_full_text_stored: { const: false },
    error_code: { type: ["string", "null"], pattern: "^[A-Z][A-Z0-9_]+$" },
    retry_after_at: nullableDateTime,
  },
};

export const EVIDENCE_PIPELINE_SCHEMAS = Object.freeze({
  EvidencePipelineManifest: pipelineManifestSchema,
  SourceAccessPlan: sourceAccessPlanSchema,
  SourceRegistryEntry: sourceRegistryEntrySchema,
  CollectionRun: collectionRunSchema,
  RawSnapshot: rawSnapshotSchema,
});

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = new Map(
  Object.entries(EVIDENCE_PIPELINE_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]),
);

function normalizeErrors(errors = []) {
  return errors.map((error) => ({
    instance_path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
}

export function validatePipelineContract(name, value) {
  const validator = validators.get(name);
  if (!validator) throw new Error(`Unknown QuietLens pipeline contract: ${name}`);
  const valid = validator(value);
  return { valid: Boolean(valid), errors: valid ? [] : normalizeErrors(validator.errors) };
}

export function assertPipelineContract(name, value, label = name) {
  const result = validatePipelineContract(name, value);
  if (!result.valid) {
    const detail = result.errors.map((error) => `${error.instance_path} ${error.message}`).join("; ");
    throw new Error(`${label} failed ${name} validation: ${detail}`);
  }
  return value;
}
