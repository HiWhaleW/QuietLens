import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyAnonymousSessionMigration,
  applySavedPreferenceProfile,
  createAccountContinuationBundle,
  createAccountDecisionRecord,
  createAnonymousSessionMigrationPlan,
  createEmptyAccountState,
  createSavedPreferenceProfile,
  restoreAccountContinuationBundle,
  saveAccountDecisionRecord,
  savePreferenceProfile,
} from "../src/ai-native/account/accountValue.js";
import { validateAccountContract } from "../src/ai-native/account/accountContracts.js";
import { validateAnalyticsEvent } from "../src/ai-native/analytics/eventContract.js";
import { makeDecisionRequest } from "./phase3b-fixtures.mjs";

const accountId = "acct-aaaaaaaaaaaaaaaa";
const createdAt = "2026-08-19T18:00:00+08:00";

function confirmedRequest(overrides = {}) {
  return makeDecisionRequest({
    request_id: "req-account-synthetic-001",
    soft_preferences: [
      { field: "daylight", priority: "high" },
      { field: "noise", priority: "medium" },
      { field: "identity", priority: "low" },
    ],
    assumptions: ["合成假设：按非实时证据比较"],
    confirmed_by_user: true,
    ...overrides,
  });
}

function candidates() {
  return [
    { place_id: "hp-east-sea", role: "primary" },
    { place_id: "hp-omnibus", role: "alternative" },
  ];
}

test("creates an empty provider-neutral account state without login data", () => {
  const state = createEmptyAccountState({ accountId, createdAt });
  assert.equal(state.version, 0);
  assert.deepEqual(state.preferences, []);
  assert.deepEqual(state.decisions, []);
  assert.equal(state.raw_text_stored, false);
  assert.equal("email" in state, false);
  assert.equal("auth_user_id" in state, false);
});

test("saves only explicit bounded preferences and never infers a sensitive profile", () => {
  const profile = createSavedPreferenceProfile({
    accountId,
    request: confirmedRequest(),
    profileKind: "focus",
    createdAt,
  });
  assert.deepEqual(profile.soft_preferences, [
    { field: "daylight", priority: "high" },
    { field: "noise", priority: "medium" },
  ]);
  assert.equal(profile.origin, "user_explicit");
  assert.equal(profile.raw_text_stored, false);
  assert.equal(profile.sensitive_profile_inferred, false);
});

test("appends an explicitly confirmed preference with optimistic version control", () => {
  const state = createEmptyAccountState({ accountId, createdAt });
  const profile = createSavedPreferenceProfile({
    accountId,
    request: confirmedRequest(),
    profileKind: "focus",
    createdAt,
  });
  const next = savePreferenceProfile(state, profile, {
    confirmed: true,
    expectedVersion: 0,
    updatedAt: "2026-08-19T18:01:00+08:00",
  });
  assert.equal(next.version, 1);
  assert.equal(next.preferences[0].profile_id, profile.profile_id);
  assert.throws(() => savePreferenceProfile(next, profile, {
    confirmed: true,
    expectedVersion: 1,
    updatedAt: "2026-08-19T18:02:00+08:00",
  }), /ACCOUNT_PREFERENCE_ALREADY_PRESENT/);
  assert.throws(() => savePreferenceProfile(state, profile, {
    confirmed: false,
    expectedVersion: 0,
    updatedAt: "2026-08-19T18:01:00+08:00",
  }), /ACCOUNT_SAVE_CONFIRMATION_REQUIRED/);
});

test("lets the current request override every conflicting saved preference", () => {
  const profile = createSavedPreferenceProfile({
    accountId,
    request: confirmedRequest(),
    profileKind: "focus",
    createdAt,
  });
  const current = confirmedRequest({
    request_id: "req-account-current-001",
    task: { type: "other", duration_minutes: null },
    location: { area: "黄浦区", max_walk_minutes: null },
    hard_constraints: [{ constraint_id: "hc-account-noise", field: "noise", operator: "equals", value: "quiet_working" }],
    soft_preferences: [{ field: "daylight", priority: "low" }],
  });
  const applied = applySavedPreferenceProfile(current, profile, { confirmed: true });
  assert.deepEqual(applied.soft_preferences, [{ field: "daylight", priority: "low" }]);
  assert.equal(applied.hard_constraints[0].field, "noise");
  assert.equal(applied.task.type, "focus");
  assert.equal(applied.task.duration_minutes, 90);
  assert.equal(applied.location.max_walk_minutes, 12);
  assert.throws(() => applySavedPreferenceProfile(current, profile, { confirmed: false }), /ACCOUNT_PREFERENCE_APPLY_CONFIRMATION_REQUIRED/);
});

test("migrates a confirmed anonymous decision without raw language or session identity", () => {
  const accountState = createEmptyAccountState({ accountId, createdAt });
  const request = confirmedRequest();
  const plan = createAnonymousSessionMigrationPlan({
    accountState,
    request,
    outcome: "published",
    candidates: candidates(),
    createdAt: "2026-08-19T18:01:00+08:00",
  });
  assert.equal(plan.status, "pending_user_confirmation");
  assert.equal(plan.record.request_snapshot.request_id, request.request_id);
  assert.equal(plan.record.request_snapshot.time.arrival_at, request.time.arrival_at);
  assert.equal(plan.record.request_snapshot.original_phrase_stored, false);
  assert.equal("original_phrase" in plan.record.request_snapshot.time, false);
  assert.equal(plan.record.raw_text_stored, false);
  assert.equal(plan.record.session_id_stored, false);
  assert.equal(JSON.stringify(plan).includes("明天下午两点"), false);

  const migrated = applyAnonymousSessionMigration(accountState, plan, {
    confirmed: true,
    migratedAt: "2026-08-19T18:02:00+08:00",
  });
  assert.equal(migrated.account_state.version, 1);
  assert.equal(migrated.account_state.decisions.length, 1);
  assert.equal(migrated.receipt.request_preserved, true);
  assert.equal(migrated.receipt.raw_text_migrated, false);
});

test("appends account history and rejects cross-account nested records", () => {
  const state = createEmptyAccountState({ accountId, createdAt });
  const record = createAccountDecisionRecord({
    accountId,
    request: confirmedRequest(),
    outcome: "published",
    candidates: candidates(),
    savedAt: "2026-08-19T18:01:00+08:00",
  });
  const next = saveAccountDecisionRecord(state, record, {
    confirmed: true,
    expectedVersion: 0,
    updatedAt: "2026-08-19T18:02:00+08:00",
  });
  assert.equal(next.version, 1);
  assert.equal(next.decisions[0].source_request_id, record.source_request_id);

  const foreignRecord = createAccountDecisionRecord({
    accountId: "acct-bbbbbbbbbbbbbbbb",
    request: confirmedRequest({ request_id: "req-account-foreign-001" }),
    outcome: "published",
    candidates: candidates(),
    savedAt: "2026-08-19T18:01:00+08:00",
  });
  assert.throws(() => saveAccountDecisionRecord(state, foreignRecord, {
    confirmed: true,
    expectedVersion: 0,
    updatedAt: "2026-08-19T18:02:00+08:00",
  }), /ACCOUNT_DECISION_ACCOUNT_MISMATCH/);
});

test("blocks unconfirmed, duplicate, stale, and cross-account migration", () => {
  const accountState = createEmptyAccountState({ accountId, createdAt });
  const plan = createAnonymousSessionMigrationPlan({
    accountState,
    request: confirmedRequest(),
    outcome: "published",
    candidates: candidates(),
    createdAt: "2026-08-19T18:01:00+08:00",
  });
  assert.throws(() => applyAnonymousSessionMigration(accountState, plan, {
    confirmed: false,
    migratedAt: "2026-08-19T18:02:00+08:00",
  }), /ACCOUNT_MIGRATION_CONFIRMATION_REQUIRED/);
  const migrated = applyAnonymousSessionMigration(accountState, plan, {
    confirmed: true,
    migratedAt: "2026-08-19T18:02:00+08:00",
  });
  assert.throws(() => applyAnonymousSessionMigration(migrated.account_state, plan, {
    confirmed: true,
    migratedAt: "2026-08-19T18:03:00+08:00",
  }), /ACCOUNT_MIGRATION_VERSION_CONFLICT/);
  const other = createEmptyAccountState({ accountId: "acct-bbbbbbbbbbbbbbbb", createdAt });
  assert.throws(() => applyAnonymousSessionMigration(other, plan, {
    confirmed: true,
    migratedAt: "2026-08-19T18:03:00+08:00",
  }), /ACCOUNT_MIGRATION_ACCOUNT_MISMATCH/);

  const nestedForeignPlan = structuredClone(plan);
  nestedForeignPlan.record.account_id = "acct-bbbbbbbbbbbbbbbb";
  assert.throws(() => applyAnonymousSessionMigration(accountState, nestedForeignPlan, {
    confirmed: true,
    migratedAt: "2026-08-19T18:03:00+08:00",
  }), /ACCOUNT_MIGRATION_ACCOUNT_MISMATCH/);
});

test("restores a cross-device continuation bundle only when its account state hash matches", async () => {
  const state = createEmptyAccountState({ accountId, createdAt });
  const bundle = await createAccountContinuationBundle(state, {
    createdAt: "2026-08-19T18:05:00+08:00",
  });
  assert.equal(bundle.raw_text_included, false);
  assert.equal(bundle.credential_included, false);
  assert.deepEqual(await restoreAccountContinuationBundle(bundle), state);

  const tampered = structuredClone(bundle);
  tampered.account_state.version = 1;
  await assert.rejects(() => restoreAccountContinuationBundle(tampered), /ACCOUNT_CONTINUATION_BUNDLE_CORRUPT/);
});

test("rejects unconfirmed requests and common sensitive values", () => {
  const accountState = createEmptyAccountState({ accountId, createdAt });
  assert.throws(() => createSavedPreferenceProfile({
    accountId,
    request: confirmedRequest({ confirmed_by_user: false }),
    profileKind: "focus",
    createdAt,
  }), /ACCOUNT_CONFIRMED_REQUEST_REQUIRED/);
  assert.throws(() => createAnonymousSessionMigrationPlan({
    accountState,
    request: confirmedRequest({ assumptions: ["联系 13800138000"] }),
    outcome: "published",
    candidates: candidates(),
    createdAt: "2026-08-19T18:01:00+08:00",
  }), /ACCOUNT_SENSITIVE_VALUE_FORBIDDEN/);
});

test("contracts forbid raw text flags and inferred sensitive profiles", () => {
  const profile = createSavedPreferenceProfile({
    accountId,
    request: confirmedRequest(),
    profileKind: "focus",
    createdAt,
  });
  assert.equal(validateAccountContract("AccountPreferenceProfile", {
    ...profile,
    sensitive_profile_inferred: true,
  }).valid, false);
  const state = createEmptyAccountState({ accountId, createdAt });
  assert.equal(validateAccountContract("AccountState", { ...state, raw_text_stored: true }).valid, false);
});

test("account migration analytics records only bounded outcomes and rejects original language", () => {
  const event = {
    event_name: "anonymous_session_migration_confirmed",
    event_schema_version: "1.0.0",
    session_id: "sess-account-synthetic-001",
    request_id: "req-account-synthetic-001",
    experience_stage: "system",
    model_version: "not_applicable",
    prompt_version: "not_applicable",
    contract_schema_version: "1.0.0",
    evidence_store_version: "0.1.0",
    client_at: createdAt,
    server_at: createdAt,
    error_code: null,
    properties: {
      outcome: "published",
      candidate_count: 2,
      resulting_account_version: 1,
      request_preserved: true,
    },
  };
  assert.equal(validateAnalyticsEvent(event).valid, true);
  event.properties.original_phrase = "明天下午两点找一家安静咖啡馆";
  assert.ok(validateAnalyticsEvent(event).issues.some((issue) => issue.code === "EVENT_PRIVACY_VIOLATION"));
});

test("keeps the production decision UI free of a placeholder login entry", async () => {
  const source = await readFile(new URL("../src/ai-native/ui/QuietLensDecisionApp.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, />\s*(?:登录|注册|创建账号)\s*</u);
  assert.doesNotMatch(source, /signIn|signUp|loginModal/u);
});
