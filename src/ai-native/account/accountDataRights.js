import { stableHexId } from "../evidence/stableId.js";
import { SAVED_PREFERENCE_FIELDS, assertAccountContract } from "./accountContracts.js";
import { assertAccountStateSafety } from "./accountValue.js";
import {
  ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION,
  assertAccountDataRightsContract,
} from "./accountDataRightsContracts.js";

const EDITABLE_PREFERENCE_FIELDS = new Set([
  "profile_kind",
  "task_type",
  "duration_minutes",
  "max_walk_minutes",
  "soft_preferences",
]);

function clone(value) {
  return structuredClone(value);
}

function validDateTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertTime(value, code) {
  if (!validDateTime(value)) throw new Error(code);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error("ACCOUNT_DATA_RIGHTS_CRYPTO_UNAVAILABLE");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertAuthorized(accountState, { authorized, accountId }) {
  assertAccountContract("AccountState", accountState, accountState?.account_id);
  assertAccountStateSafety(accountState);
  if (authorized !== true) throw new Error("ACCOUNT_DATA_ACCESS_UNAUTHORIZED");
  if (accountId !== accountState.account_id) throw new Error("ACCOUNT_DATA_ACCOUNT_MISMATCH");
}

function assertMutation(accountState, options) {
  assertAuthorized(accountState, options);
  if (options.confirmed !== true) throw new Error("ACCOUNT_DATA_CONFIRMATION_REQUIRED");
  if (options.expectedVersion !== accountState.version) throw new Error("ACCOUNT_DATA_VERSION_CONFLICT");
  assertTime(options.updatedAt, "ACCOUNT_DATA_UPDATED_AT_INVALID");
  if (Date.parse(options.updatedAt) < Date.parse(accountState.updated_at)) {
    throw new Error("ACCOUNT_DATA_UPDATED_AT_INVALID");
  }
}

export function createAccountDataView(accountState, { authorized, accountId, generatedAt }) {
  assertAuthorized(accountState, { authorized, accountId });
  assertTime(generatedAt, "ACCOUNT_DATA_VIEW_TIME_INVALID");
  return assertAccountDataRightsContract("AccountDataView", {
    schema_version: ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION,
    generated_at: generatedAt,
    account_state: clone(accountState),
    raw_text_included: false,
    credential_included: false,
  });
}

export function editAccountPreference(accountState, { profileId, changes }, options) {
  assertMutation(accountState, options);
  if (!changes || typeof changes !== "object" || Array.isArray(changes)
    || Object.keys(changes).length === 0
    || Object.keys(changes).some((key) => !EDITABLE_PREFERENCE_FIELDS.has(key))) {
    throw new Error("ACCOUNT_PREFERENCE_EDIT_INVALID");
  }
  const index = accountState.preferences.findIndex((profile) => profile.profile_id === profileId);
  if (index < 0) throw new Error("ACCOUNT_PREFERENCE_NOT_FOUND");
  if (Array.isArray(changes.soft_preferences)) {
    const allowed = new Set(SAVED_PREFERENCE_FIELDS);
    if (changes.soft_preferences.some((item) => !allowed.has(item?.field))) {
      throw new Error("ACCOUNT_PREFERENCE_EDIT_INVALID");
    }
  }
  const replacement = assertAccountContract("AccountPreferenceProfile", {
    ...clone(accountState.preferences[index]),
    ...clone(changes),
    updated_at: options.updatedAt,
  }, profileId);
  const preferences = clone(accountState.preferences);
  preferences[index] = replacement;
  return assertAccountStateSafety(assertAccountContract("AccountState", {
    ...clone(accountState),
    version: accountState.version + 1,
    preferences,
    updated_at: options.updatedAt,
  }, accountState.account_id));
}

export async function createAccountDataExport(accountState, { authorized, accountId, confirmed, createdAt }) {
  assertAuthorized(accountState, { authorized, accountId });
  if (confirmed !== true) throw new Error("ACCOUNT_DATA_EXPORT_CONFIRMATION_REQUIRED");
  assertTime(createdAt, "ACCOUNT_DATA_EXPORT_TIME_INVALID");
  const state = clone(accountState);
  const accountStateSha256 = await sha256(canonicalJson(state));
  return assertAccountDataRightsContract("AccountDataExport", {
    schema_version: ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION,
    export_id: `account-export-${accountStateSha256.slice(0, 16)}`,
    created_at: createdAt,
    portable_format: "json",
    account_state_sha256: accountStateSha256,
    account_state: state,
    raw_text_included: false,
    credential_included: false,
  });
}

export async function verifyAccountDataExport(dataExport) {
  assertAccountDataRightsContract("AccountDataExport", dataExport, dataExport?.export_id);
  assertAccountStateSafety(dataExport.account_state);
  const expectedHash = await sha256(canonicalJson(dataExport.account_state));
  if (dataExport.account_state_sha256 !== expectedHash
    || dataExport.export_id !== `account-export-${expectedHash.slice(0, 16)}`) {
    throw new Error("ACCOUNT_DATA_EXPORT_CORRUPT");
  }
  return true;
}

export function deleteAccountDataRecord(accountState, { recordType, recordId }, options) {
  assertMutation(accountState, options);
  const collectionName = recordType === "preference" ? "preferences"
    : recordType === "decision" ? "decisions"
      : null;
  if (!collectionName) throw new Error("ACCOUNT_DATA_RECORD_TYPE_INVALID");
  const idField = recordType === "preference" ? "profile_id" : "history_id";
  const index = accountState[collectionName].findIndex((record) => record[idField] === recordId);
  if (index < 0) throw new Error("ACCOUNT_DATA_RECORD_NOT_FOUND");
  const nextCollection = accountState[collectionName].filter((_, itemIndex) => itemIndex !== index);
  const nextVersion = accountState.version + 1;
  const nextState = assertAccountStateSafety(assertAccountContract("AccountState", {
    ...clone(accountState),
    [collectionName]: nextCollection,
    version: nextVersion,
    updated_at: options.updatedAt,
  }, accountState.account_id));
  const receipt = assertAccountDataRightsContract("AccountDataDeletionReceipt", {
    schema_version: ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION,
    receipt_id: `data-deletion-${stableHexId(`${accountState.account_id}|${recordType}|${recordId}|${options.updatedAt}`)}`,
    account_id: accountState.account_id,
    record_type: recordType,
    record_id: recordId,
    deleted_at: options.updatedAt,
    resulting_account_version: nextVersion,
    deleted_record_content_retained: false,
  });
  return Object.freeze({ account_state: nextState, receipt });
}

export function createAccountClosurePlan(accountState, { authorized, accountId, createdAt }) {
  assertAuthorized(accountState, { authorized, accountId });
  assertTime(createdAt, "ACCOUNT_CLOSURE_TIME_INVALID");
  return assertAccountDataRightsContract("AccountClosurePlan", {
    schema_version: ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION,
    plan_id: `account-closure-${stableHexId(`${accountState.account_id}|${accountState.version}|${createdAt}`)}`,
    account_id: accountState.account_id,
    expected_account_version: accountState.version,
    created_at: createdAt,
    status: "pending_user_confirmation",
    requires_user_confirmation: true,
    automatic_apply_allowed: false,
  });
}

export async function applyAccountClosure(accountState, plan, { authorized, accountId, confirmed, closedAt }) {
  assertAuthorized(accountState, { authorized, accountId });
  assertAccountDataRightsContract("AccountClosurePlan", plan, plan?.plan_id);
  if (confirmed !== true) throw new Error("ACCOUNT_CLOSURE_CONFIRMATION_REQUIRED");
  if (plan.account_id !== accountState.account_id) throw new Error("ACCOUNT_CLOSURE_ACCOUNT_MISMATCH");
  if (plan.expected_account_version !== accountState.version) throw new Error("ACCOUNT_CLOSURE_VERSION_CONFLICT");
  assertTime(closedAt, "ACCOUNT_CLOSURE_TIME_INVALID");
  if (Date.parse(closedAt) < Date.parse(plan.created_at)) throw new Error("ACCOUNT_CLOSURE_TIME_INVALID");
  const accountIdSha256 = await sha256(accountState.account_id);
  const receipt = assertAccountDataRightsContract("AccountClosureReceipt", {
    schema_version: ACCOUNT_DATA_RIGHTS_SCHEMA_VERSION,
    receipt_id: `account-closure-receipt-${stableHexId(`${plan.plan_id}|${closedAt}`)}`,
    plan_id: plan.plan_id,
    account_id_sha256: accountIdSha256,
    closed_at: closedAt,
    deleted_preference_count: accountState.preferences.length,
    deleted_decision_count: accountState.decisions.length,
    account_content_retained: false,
    closure_audit_digest_retained: true,
    credential_retained: false,
    recovery_available: false,
    status: "completed",
  });
  return Object.freeze({ account_state: null, receipt });
}
