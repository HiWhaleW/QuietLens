import Ajv from "ajv";

import { EVIDENCE_ATTRIBUTES } from "../contracts/schemas.js";

export const ACCOUNT_SCHEMA_VERSION = "1.0.0";

export const SAVED_PREFERENCE_FIELDS = Object.freeze([
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
const accountIdPattern = "^acct-[a-f0-9]{16}$";
const requestIdPattern = "^req-[a-z0-9]+(?:-[a-z0-9]+)*$";
const profileIdPattern = "^pref-[a-f0-9]{16}$";
const historyIdPattern = "^history-[a-f0-9]{16}$";
const migrationIdPattern = "^migration-[a-f0-9]{16}$";
const receiptIdPattern = "^migration-receipt-[a-f0-9]{16}$";
const bundleIdPattern = "^continuation-[a-f0-9]{16}$";
const hashPattern = "^[a-f0-9]{64}$";
const nullableDateTime = { type: ["string", "null"], pattern: dateTimePattern };

const savedPreferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["field", "priority"],
  properties: {
    field: { enum: SAVED_PREFERENCE_FIELDS },
    priority: { enum: ["low", "medium", "high"] },
  },
};

const requestPreferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["field", "priority"],
  properties: {
    field: { enum: EVIDENCE_ATTRIBUTES },
    priority: { enum: ["low", "medium", "high"] },
  },
};

const constraintSchema = {
  type: "object",
  additionalProperties: false,
  required: ["constraint_id", "field", "operator", "value"],
  properties: {
    constraint_id: { type: "string", pattern: "^hc-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    field: { enum: EVIDENCE_ATTRIBUTES },
    operator: { enum: ["equals", "supports", "at_least", "at_most", "available", "not_equals"] },
    value: { type: ["string", "number", "boolean", "array"] },
  },
};

const requestSnapshotSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "request_id",
    "evidence_store_version",
    "task",
    "time",
    "location",
    "hard_constraints",
    "soft_preferences",
    "unknowns",
    "assumptions",
    "confirmed_by_user",
    "original_phrase_stored",
  ],
  properties: {
    schema_version: { type: "string", minLength: 1, maxLength: 40 },
    request_id: { type: "string", pattern: requestIdPattern },
    evidence_store_version: { type: "string", minLength: 1, maxLength: 40 },
    task: {
      type: "object",
      additionalProperties: false,
      required: ["type", "duration_minutes"],
      properties: {
        type: { enum: ["focus", "recovery", "conversation", "call", "other"] },
        duration_minutes: { type: ["integer", "null"], minimum: 1, maximum: 480 },
      },
    },
    time: {
      type: "object",
      additionalProperties: false,
      required: ["arrival_at", "hard_leave_at"],
      properties: {
        arrival_at: nullableDateTime,
        hard_leave_at: nullableDateTime,
      },
    },
    location: {
      type: "object",
      additionalProperties: false,
      required: ["area", "max_walk_minutes"],
      properties: {
        area: { type: "string", minLength: 1, maxLength: 40 },
        max_walk_minutes: { type: ["integer", "null"], minimum: 1, maximum: 90 },
      },
    },
    hard_constraints: { type: "array", maxItems: 20, items: constraintSchema },
    soft_preferences: { type: "array", maxItems: 20, items: requestPreferenceSchema },
    unknowns: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 80 } },
    assumptions: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 160 } },
    confirmed_by_user: { const: true },
    original_phrase_stored: { const: false },
  },
};

export const accountPreferenceProfileSchema = {
  $id: "https://quietlens.local/schema/account-preference-profile-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountPreferenceProfile",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "profile_id",
    "account_id",
    "profile_kind",
    "task_type",
    "duration_minutes",
    "max_walk_minutes",
    "soft_preferences",
    "created_at",
    "updated_at",
    "status",
    "origin",
    "raw_text_stored",
    "sensitive_profile_inferred",
  ],
  properties: {
    schema_version: { const: ACCOUNT_SCHEMA_VERSION },
    profile_id: { type: "string", pattern: profileIdPattern },
    account_id: { type: "string", pattern: accountIdPattern },
    profile_kind: { enum: ["focus", "recovery", "conversation", "call", "custom"] },
    task_type: { enum: ["focus", "recovery", "conversation", "call", "other"] },
    duration_minutes: { type: ["integer", "null"], minimum: 1, maximum: 480 },
    max_walk_minutes: { type: ["integer", "null"], minimum: 1, maximum: 90 },
    soft_preferences: { type: "array", maxItems: 8, uniqueItems: true, items: savedPreferenceSchema },
    created_at: { type: "string", pattern: dateTimePattern },
    updated_at: { type: "string", pattern: dateTimePattern },
    status: { const: "active" },
    origin: { const: "user_explicit" },
    raw_text_stored: { const: false },
    sensitive_profile_inferred: { const: false },
  },
};

export const accountDecisionRecordSchema = {
  $id: "https://quietlens.local/schema/account-decision-record-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountDecisionRecord",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "history_id",
    "account_id",
    "source_request_id",
    "request_snapshot",
    "outcome",
    "candidates",
    "saved_at",
    "raw_text_stored",
    "session_id_stored",
    "model_response_stored",
  ],
  properties: {
    schema_version: { const: ACCOUNT_SCHEMA_VERSION },
    history_id: { type: "string", pattern: historyIdPattern },
    account_id: { type: "string", pattern: accountIdPattern },
    source_request_id: { type: "string", pattern: requestIdPattern },
    request_snapshot: requestSnapshotSchema,
    outcome: { enum: ["published", "refused"] },
    candidates: {
      type: "array",
      maxItems: 3,
      uniqueItems: true,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["place_id", "role"],
        properties: {
          place_id: { type: "string", pattern: "^hp-[a-z0-9]+(?:-[a-z0-9]+)*$" },
          role: { enum: ["primary", "conditional", "alternative"] },
        },
      },
    },
    saved_at: { type: "string", pattern: dateTimePattern },
    raw_text_stored: { const: false },
    session_id_stored: { const: false },
    model_response_stored: { const: false },
  },
};

export const accountStateSchema = {
  $id: "https://quietlens.local/schema/account-state-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountState",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "account_id", "version", "preferences", "decisions", "created_at", "updated_at", "raw_text_stored"],
  properties: {
    schema_version: { const: ACCOUNT_SCHEMA_VERSION },
    account_id: { type: "string", pattern: accountIdPattern },
    version: { type: "integer", minimum: 0 },
    preferences: { type: "array", maxItems: 20, items: accountPreferenceProfileSchema },
    decisions: { type: "array", maxItems: 200, items: accountDecisionRecordSchema },
    created_at: { type: "string", pattern: dateTimePattern },
    updated_at: { type: "string", pattern: dateTimePattern },
    raw_text_stored: { const: false },
  },
};

export const accountMigrationPlanSchema = {
  $id: "https://quietlens.local/schema/account-migration-plan-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountMigrationPlan",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "migration_id", "account_id", "expected_account_version", "source", "record", "created_at", "status", "requires_user_confirmation", "raw_text_stored"],
  properties: {
    schema_version: { const: ACCOUNT_SCHEMA_VERSION },
    migration_id: { type: "string", pattern: migrationIdPattern },
    account_id: { type: "string", pattern: accountIdPattern },
    expected_account_version: { type: "integer", minimum: 0 },
    source: { const: "anonymous_session" },
    record: accountDecisionRecordSchema,
    created_at: { type: "string", pattern: dateTimePattern },
    status: { const: "pending_user_confirmation" },
    requires_user_confirmation: { const: true },
    raw_text_stored: { const: false },
  },
};

export const accountMigrationReceiptSchema = {
  $id: "https://quietlens.local/schema/account-migration-receipt-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountMigrationReceipt",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "receipt_id", "migration_id", "account_id", "source_request_id", "migrated_at", "resulting_account_version", "request_preserved", "raw_text_migrated"],
  properties: {
    schema_version: { const: ACCOUNT_SCHEMA_VERSION },
    receipt_id: { type: "string", pattern: receiptIdPattern },
    migration_id: { type: "string", pattern: migrationIdPattern },
    account_id: { type: "string", pattern: accountIdPattern },
    source_request_id: { type: "string", pattern: requestIdPattern },
    migrated_at: { type: "string", pattern: dateTimePattern },
    resulting_account_version: { type: "integer", minimum: 1 },
    request_preserved: { const: true },
    raw_text_migrated: { const: false },
  },
};

export const accountContinuationBundleSchema = {
  $id: "https://quietlens.local/schema/account-continuation-bundle-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountContinuationBundle",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "bundle_id", "created_at", "account_state_sha256", "account_state", "raw_text_included", "credential_included"],
  properties: {
    schema_version: { const: ACCOUNT_SCHEMA_VERSION },
    bundle_id: { type: "string", pattern: bundleIdPattern },
    created_at: { type: "string", pattern: dateTimePattern },
    account_state_sha256: { type: "string", pattern: hashPattern },
    account_state: accountStateSchema,
    raw_text_included: { const: false },
    credential_included: { const: false },
  },
};

export const ACCOUNT_SCHEMAS = Object.freeze({
  AccountPreferenceProfile: accountPreferenceProfileSchema,
  AccountDecisionRecord: accountDecisionRecordSchema,
  AccountState: accountStateSchema,
  AccountMigrationPlan: accountMigrationPlanSchema,
  AccountMigrationReceipt: accountMigrationReceiptSchema,
  AccountContinuationBundle: accountContinuationBundleSchema,
});

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validators = new Map(Object.entries(ACCOUNT_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]));

function normalizeErrors(errors = []) {
  return errors.map((error) => ({
    instance_path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
}

export function validateAccountContract(name, value) {
  const validator = validators.get(name);
  if (!validator) throw new Error(`Unknown QuietLens account contract: ${name}`);
  const valid = validator(value);
  return { valid: Boolean(valid), errors: valid ? [] : normalizeErrors(validator.errors) };
}

export function assertAccountContract(name, value, label = name) {
  const result = validateAccountContract(name, value);
  if (!result.valid) {
    const detail = result.errors.map((error) => `${error.instance_path} ${error.message}`).join("; ");
    throw new Error(`${label} failed ${name} validation: ${detail}`);
  }
  return value;
}
