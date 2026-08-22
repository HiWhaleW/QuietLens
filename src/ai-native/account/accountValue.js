import { assertContract } from "../contracts/validator.js";
import { stableHexId } from "../evidence/stableId.js";
import {
  ACCOUNT_SCHEMA_VERSION,
  SAVED_PREFERENCE_FIELDS,
  assertAccountContract,
} from "./accountContracts.js";

const SENSITIVE_PATTERNS = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:\+?86[-\s]?)?1[3-9]\d{9}/u,
  /(?:api[_-]?key|bearer)\s*[:= ]\s*\S+/iu,
  /(?:^|\s)\/[A-Za-z0-9._/-]+/u,
];

function validDateTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertTime(value, code) {
  if (!validDateTime(value)) throw new Error(code);
}

function containsSensitiveValue(value) {
  if (Array.isArray(value)) return value.some(containsSensitiveValue);
  if (value && typeof value === "object") return Object.values(value).some(containsSensitiveValue);
  return typeof value === "string" && SENSITIVE_PATTERNS.some((pattern) => pattern.test(value));
}

function assertPrivacySafe(value) {
  if (containsSensitiveValue(value)) throw new Error("ACCOUNT_SENSITIVE_VALUE_FORBIDDEN");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error("ACCOUNT_CONTINUATION_CRYPTO_UNAVAILABLE");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clone(value) {
  return structuredClone(value);
}

export function assertAccountStateSafety(accountState) {
  for (const profile of accountState.preferences) {
    if (profile.account_id !== accountState.account_id) {
      throw new Error("ACCOUNT_PREFERENCE_ACCOUNT_MISMATCH");
    }
  }
  for (const record of accountState.decisions) {
    if (record.account_id !== accountState.account_id) {
      throw new Error("ACCOUNT_DECISION_ACCOUNT_MISMATCH");
    }
  }
  assertPrivacySafe(accountState);
  return accountState;
}

function assertAccountUpdate(accountState, { confirmed, expectedVersion, updatedAt }) {
  if (confirmed !== true) throw new Error("ACCOUNT_SAVE_CONFIRMATION_REQUIRED");
  if (expectedVersion !== accountState.version) throw new Error("ACCOUNT_VERSION_CONFLICT");
  assertTime(updatedAt, "ACCOUNT_UPDATED_AT_INVALID");
  if (Date.parse(updatedAt) < Date.parse(accountState.updated_at)) {
    throw new Error("ACCOUNT_UPDATED_AT_INVALID");
  }
}

export function createEmptyAccountState({ accountId, createdAt }) {
  assertTime(createdAt, "ACCOUNT_CREATED_AT_INVALID");
  return assertAccountContract("AccountState", {
    schema_version: ACCOUNT_SCHEMA_VERSION,
    account_id: accountId,
    version: 0,
    preferences: [],
    decisions: [],
    created_at: createdAt,
    updated_at: createdAt,
    raw_text_stored: false,
  }, accountId);
}

export function savePreferenceProfile(accountState, profile, options) {
  assertAccountContract("AccountState", accountState, accountState?.account_id);
  assertAccountStateSafety(accountState);
  assertAccountContract("AccountPreferenceProfile", profile, profile?.profile_id);
  assertAccountUpdate(accountState, options);
  if (profile.account_id !== accountState.account_id) throw new Error("ACCOUNT_PREFERENCE_ACCOUNT_MISMATCH");
  if (accountState.preferences.some((item) => item.profile_id === profile.profile_id)) {
    throw new Error("ACCOUNT_PREFERENCE_ALREADY_PRESENT");
  }
  if (Date.parse(options.updatedAt) < Date.parse(profile.updated_at)) {
    throw new Error("ACCOUNT_UPDATED_AT_INVALID");
  }
  return assertAccountStateSafety(assertAccountContract("AccountState", {
    ...clone(accountState),
    version: accountState.version + 1,
    preferences: [...accountState.preferences, clone(profile)],
    updated_at: options.updatedAt,
  }, accountState.account_id));
}

export function saveAccountDecisionRecord(accountState, record, options) {
  assertAccountContract("AccountState", accountState, accountState?.account_id);
  assertAccountStateSafety(accountState);
  assertAccountContract("AccountDecisionRecord", record, record?.history_id);
  assertAccountUpdate(accountState, options);
  if (record.account_id !== accountState.account_id) throw new Error("ACCOUNT_DECISION_ACCOUNT_MISMATCH");
  if (accountState.decisions.some((item) => item.history_id === record.history_id
    || item.source_request_id === record.source_request_id)) {
    throw new Error("ACCOUNT_DECISION_ALREADY_PRESENT");
  }
  if (Date.parse(options.updatedAt) < Date.parse(record.saved_at)) {
    throw new Error("ACCOUNT_UPDATED_AT_INVALID");
  }
  return assertAccountStateSafety(assertAccountContract("AccountState", {
    ...clone(accountState),
    version: accountState.version + 1,
    decisions: [...accountState.decisions, clone(record)],
    updated_at: options.updatedAt,
  }, accountState.account_id));
}

export function createSavedPreferenceProfile({ accountId, request, profileKind, createdAt }) {
  assertContract("DecisionRequest", request, request?.request_id);
  if (request.confirmed_by_user !== true) throw new Error("ACCOUNT_CONFIRMED_REQUEST_REQUIRED");
  assertTime(createdAt, "ACCOUNT_PREFERENCE_TIME_INVALID");
  const allowed = new Set(SAVED_PREFERENCE_FIELDS);
  const preferenceByField = new Map();
  for (const item of request.soft_preferences) {
    if (allowed.has(item.field)) preferenceByField.set(item.field, item);
  }
  const profileBase = {
    schema_version: ACCOUNT_SCHEMA_VERSION,
    account_id: accountId,
    profile_kind: profileKind,
    task_type: request.task.type,
    duration_minutes: request.task.duration_minutes,
    max_walk_minutes: request.location.max_walk_minutes,
    soft_preferences: [...preferenceByField.values()].sort((left, right) => left.field.localeCompare(right.field)),
    created_at: createdAt,
    updated_at: createdAt,
    status: "active",
    origin: "user_explicit",
    raw_text_stored: false,
    sensitive_profile_inferred: false,
  };
  assertPrivacySafe(profileBase);
  const profile = {
    ...profileBase,
    profile_id: `pref-${stableHexId(`${accountId}|${profileKind}|${request.request_id}|${createdAt}`)}`,
  };
  return assertAccountContract("AccountPreferenceProfile", profile, profile.profile_id);
}

export function applySavedPreferenceProfile(request, profile, { confirmed }) {
  assertContract("DecisionRequest", request, request?.request_id);
  assertAccountContract("AccountPreferenceProfile", profile, profile?.profile_id);
  if (confirmed !== true) throw new Error("ACCOUNT_PREFERENCE_APPLY_CONFIRMATION_REQUIRED");
  const next = clone(request);
  const explicitFields = new Set([
    ...next.hard_constraints.map((item) => item.field),
    ...next.soft_preferences.map((item) => item.field),
  ]);
  next.soft_preferences = [
    ...next.soft_preferences,
    ...profile.soft_preferences.filter((item) => !explicitFields.has(item.field)),
  ];
  if (next.task.type === "other") next.task.type = profile.task_type;
  if (next.task.duration_minutes === null) next.task.duration_minutes = profile.duration_minutes;
  if (next.location.max_walk_minutes === null) next.location.max_walk_minutes = profile.max_walk_minutes;
  next.confirmed_by_user = true;
  return assertContract("DecisionRequest", next, next.request_id);
}

function requestSnapshot(request) {
  const snapshot = {
    schema_version: request.schema_version,
    request_id: request.request_id,
    evidence_store_version: request.evidence_store_version,
    task: clone(request.task),
    time: {
      arrival_at: request.time.arrival_at,
      hard_leave_at: request.time.hard_leave_at,
    },
    location: clone(request.location),
    hard_constraints: clone(request.hard_constraints),
    soft_preferences: clone(request.soft_preferences),
    unknowns: clone(request.unknowns),
    assumptions: clone(request.assumptions),
    confirmed_by_user: true,
    original_phrase_stored: false,
  };
  assertPrivacySafe(snapshot);
  return snapshot;
}

export function createAccountDecisionRecord({ accountId, request, outcome, candidates, savedAt }) {
  assertContract("DecisionRequest", request, request?.request_id);
  if (request.confirmed_by_user !== true) throw new Error("ACCOUNT_CONFIRMED_REQUEST_REQUIRED");
  if (!Array.isArray(candidates)) throw new Error("ACCOUNT_DECISION_CANDIDATES_INVALID");
  if ((outcome === "published" && candidates.length === 0)
    || (outcome === "refused" && candidates.length !== 0)
    || new Set(candidates.map((candidate) => candidate.place_id)).size !== candidates.length) {
    throw new Error("ACCOUNT_DECISION_CANDIDATES_INVALID");
  }
  assertTime(savedAt, "ACCOUNT_DECISION_TIME_INVALID");
  const recordBase = {
    schema_version: ACCOUNT_SCHEMA_VERSION,
    account_id: accountId,
    source_request_id: request.request_id,
    request_snapshot: requestSnapshot(request),
    outcome,
    candidates: candidates.map(({ place_id: placeId, role }) => ({ place_id: placeId, role })),
    saved_at: savedAt,
    raw_text_stored: false,
    session_id_stored: false,
    model_response_stored: false,
  };
  const record = {
    ...recordBase,
    history_id: `history-${stableHexId(`${accountId}|${request.request_id}|${savedAt}`)}`,
  };
  return assertAccountContract("AccountDecisionRecord", record, record.history_id);
}

export function createAnonymousSessionMigrationPlan({ accountState, request, outcome, candidates, createdAt }) {
  assertAccountContract("AccountState", accountState, accountState?.account_id);
  assertAccountStateSafety(accountState);
  const record = createAccountDecisionRecord({
    accountId: accountState.account_id,
    request,
    outcome,
    candidates,
    savedAt: createdAt,
  });
  const plan = {
    schema_version: ACCOUNT_SCHEMA_VERSION,
    migration_id: `migration-${stableHexId(`${accountState.account_id}|${accountState.version}|${request.request_id}|${createdAt}`)}`,
    account_id: accountState.account_id,
    expected_account_version: accountState.version,
    source: "anonymous_session",
    record,
    created_at: createdAt,
    status: "pending_user_confirmation",
    requires_user_confirmation: true,
    raw_text_stored: false,
  };
  return assertAccountContract("AccountMigrationPlan", plan, plan.migration_id);
}

export function applyAnonymousSessionMigration(accountState, plan, { confirmed, migratedAt }) {
  assertAccountContract("AccountState", accountState, accountState?.account_id);
  assertAccountStateSafety(accountState);
  assertAccountContract("AccountMigrationPlan", plan, plan?.migration_id);
  if (confirmed !== true) throw new Error("ACCOUNT_MIGRATION_CONFIRMATION_REQUIRED");
  if (plan.account_id !== accountState.account_id) throw new Error("ACCOUNT_MIGRATION_ACCOUNT_MISMATCH");
  if (plan.record.account_id !== plan.account_id) throw new Error("ACCOUNT_MIGRATION_ACCOUNT_MISMATCH");
  if (plan.expected_account_version !== accountState.version) throw new Error("ACCOUNT_MIGRATION_VERSION_CONFLICT");
  if (accountState.decisions.some((record) => record.source_request_id === plan.record.source_request_id)) {
    throw new Error("ACCOUNT_MIGRATION_REQUEST_ALREADY_PRESENT");
  }
  assertTime(migratedAt, "ACCOUNT_MIGRATION_TIME_INVALID");
  if (Date.parse(migratedAt) < Date.parse(plan.created_at)) throw new Error("ACCOUNT_MIGRATION_TIME_INVALID");
  const nextVersion = accountState.version + 1;
  const nextState = assertAccountContract("AccountState", {
    ...clone(accountState),
    version: nextVersion,
    decisions: [...accountState.decisions, clone(plan.record)],
    updated_at: migratedAt,
  }, accountState.account_id);
  const receipt = assertAccountContract("AccountMigrationReceipt", {
    schema_version: ACCOUNT_SCHEMA_VERSION,
    receipt_id: `migration-receipt-${stableHexId(`${plan.migration_id}|${migratedAt}`)}`,
    migration_id: plan.migration_id,
    account_id: accountState.account_id,
    source_request_id: plan.record.source_request_id,
    migrated_at: migratedAt,
    resulting_account_version: nextVersion,
    request_preserved: true,
    raw_text_migrated: false,
  });
  return Object.freeze({ account_state: nextState, receipt });
}

export async function createAccountContinuationBundle(accountState, { createdAt }) {
  assertAccountContract("AccountState", accountState, accountState?.account_id);
  assertAccountStateSafety(accountState);
  assertTime(createdAt, "ACCOUNT_CONTINUATION_TIME_INVALID");
  const state = clone(accountState);
  const accountStateSha256 = await sha256(canonicalJson(state));
  return assertAccountContract("AccountContinuationBundle", {
    schema_version: ACCOUNT_SCHEMA_VERSION,
    bundle_id: `continuation-${accountStateSha256.slice(0, 16)}`,
    created_at: createdAt,
    account_state_sha256: accountStateSha256,
    account_state: state,
    raw_text_included: false,
    credential_included: false,
  });
}

export async function restoreAccountContinuationBundle(bundle) {
  assertAccountContract("AccountContinuationBundle", bundle, bundle?.bundle_id);
  assertAccountStateSafety(bundle.account_state);
  const expectedHash = await sha256(canonicalJson(bundle.account_state));
  if (expectedHash !== bundle.account_state_sha256
    || bundle.bundle_id !== `continuation-${expectedHash.slice(0, 16)}`) {
    throw new Error("ACCOUNT_CONTINUATION_BUNDLE_CORRUPT");
  }
  return clone(bundle.account_state);
}
