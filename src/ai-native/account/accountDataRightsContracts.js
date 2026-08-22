import Ajv from "ajv";

import { accountStateSchema } from "./accountContracts.js";

export const ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION = "1.0.0";

const dateTimePattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$";
const accountIdPattern = "^acct-[a-f0-9]{16}$";
const hashPattern = "^[a-f0-9]{64}$";
const exportIdPattern = "^account-export-[a-f0-9]{16}$";
const deletionReceiptIdPattern = "^data-deletion-[a-f0-9]{16}$";
const recordIdPattern = "^(?:pref|history)-[a-f0-9]{16}$";
const closurePlanIdPattern = "^account-closure-[a-f0-9]{16}$";
const closureReceiptIdPattern = "^account-closure-receipt-[a-f0-9]{16}$";

export const accountDataViewSchema = {
  $id: "https://quietlens.local/schema/account-data-view-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountDataView",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "generated_at", "account_state", "raw_text_included", "credential_included"],
  properties: {
    schema_version: { const: ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION },
    generated_at: { type: "string", pattern: dateTimePattern },
    account_state: { $ref: accountStateSchema.$id },
    raw_text_included: { const: false },
    credential_included: { const: false },
  },
};

export const accountDataExportSchema = {
  $id: "https://quietlens.local/schema/account-data-export-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountDataExport",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "export_id",
    "created_at",
    "portable_format",
    "account_state_sha256",
    "account_state",
    "raw_text_included",
    "credential_included",
  ],
  properties: {
    schema_version: { const: ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION },
    export_id: { type: "string", pattern: exportIdPattern },
    created_at: { type: "string", pattern: dateTimePattern },
    portable_format: { const: "json" },
    account_state_sha256: { type: "string", pattern: hashPattern },
    account_state: { $ref: accountStateSchema.$id },
    raw_text_included: { const: false },
    credential_included: { const: false },
  },
};

export const accountDataDeletionReceiptSchema = {
  $id: "https://quietlens.local/schema/account-data-deletion-receipt-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountDataDeletionReceipt",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "receipt_id",
    "account_id",
    "record_type",
    "record_id",
    "deleted_at",
    "resulting_account_version",
    "deleted_record_content_retained",
  ],
  properties: {
    schema_version: { const: ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION },
    receipt_id: { type: "string", pattern: deletionReceiptIdPattern },
    account_id: { type: "string", pattern: accountIdPattern },
    record_type: { enum: ["preference", "decision"] },
    record_id: { type: "string", pattern: recordIdPattern },
    deleted_at: { type: "string", pattern: dateTimePattern },
    resulting_account_version: { type: "integer", minimum: 1 },
    deleted_record_content_retained: { const: false },
  },
};

export const accountClosurePlanSchema = {
  $id: "https://quietlens.local/schema/account-closure-plan-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountClosurePlan",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "plan_id",
    "account_id",
    "expected_account_version",
    "created_at",
    "status",
    "requires_user_confirmation",
    "automatic_apply_allowed",
  ],
  properties: {
    schema_version: { const: ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION },
    plan_id: { type: "string", pattern: closurePlanIdPattern },
    account_id: { type: "string", pattern: accountIdPattern },
    expected_account_version: { type: "integer", minimum: 0 },
    created_at: { type: "string", pattern: dateTimePattern },
    status: { const: "pending_user_confirmation" },
    requires_user_confirmation: { const: true },
    automatic_apply_allowed: { const: false },
  },
};

export const accountClosureReceiptSchema = {
  $id: "https://quietlens.local/schema/account-closure-receipt-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AccountClosureReceipt",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "receipt_id",
    "plan_id",
    "account_id_sha256",
    "closed_at",
    "deleted_preference_count",
    "deleted_decision_count",
    "account_content_retained",
    "closure_audit_digest_retained",
    "credential_retained",
    "recovery_available",
    "status",
  ],
  properties: {
    schema_version: { const: ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION },
    receipt_id: { type: "string", pattern: closureReceiptIdPattern },
    plan_id: { type: "string", pattern: closurePlanIdPattern },
    account_id_sha256: { type: "string", pattern: hashPattern },
    closed_at: { type: "string", pattern: dateTimePattern },
    deleted_preference_count: { type: "integer", minimum: 0 },
    deleted_decision_count: { type: "integer", minimum: 0 },
    account_content_retained: { const: false },
    closure_audit_digest_retained: { const: true },
    credential_retained: { const: false },
    recovery_available: { const: false },
    status: { const: "completed" },
  },
};

export const ACCOUNT_DATA_RIGHTS_SCHEMAS = Object.freeze({
  AccountDataView: accountDataViewSchema,
  AccountDataExport: accountDataExportSchema,
  AccountDataDeletionReceipt: accountDataDeletionReceiptSchema,
  AccountClosurePlan: accountClosurePlanSchema,
  AccountClosureReceipt: accountClosureReceiptSchema,
});

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
ajv.addSchema(accountStateSchema);
const validators = new Map(Object.entries(ACCOUNT_DATA_RIGHTS_SCHEMAS).map(([name, schema]) => [name, ajv.compile(schema)]));

function normalizeErrors(errors = []) {
  return errors.map((error) => ({
    instance_path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message,
    params: error.params,
  }));
}

export function validateAccountDataRightsContract(name, value) {
  const validator = validators.get(name);
  if (!validator) throw new Error(`Unknown QuietLens account data rights contract: ${name}`);
  const valid = validator(value);
  return { valid: Boolean(valid), errors: valid ? [] : normalizeErrors(validator.errors) };
}

export function assertAccountDataRightsContract(name, value, label = name) {
  const result = validateAccountDataRightsContract(name, value);
  if (!result.valid) {
    const detail = result.errors.map((error) => `${error.instance_path} ${error.message}`).join("; ");
    throw new Error(`${label} failed ${name} validation: ${detail}`);
  }
  return value;
}
