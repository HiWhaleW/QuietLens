import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAccountClosure,
  createAccountClosurePlan,
  createAccountDataExport,
  createAccountDataView,
  deleteAccountDataRecord,
  editAccountPreference,
  verifyAccountDataExport,
} from "../src/ai-native/account/accountDataRights.js";
import {
  createAccountDecisionRecord,
  createEmptyAccountState,
  createSavedPreferenceProfile,
  saveAccountDecisionRecord,
  savePreferenceProfile,
} from "../src/ai-native/account/accountValue.js";
import { makeDecisionRequest } from "./phase3b-fixtures.mjs";

const accountId = "acct-cccccccccccccccc";
const otherAccountId = "acct-dddddddddddddddd";
const t0 = "2026-08-19T19:00:00+08:00";

function request() {
  return makeDecisionRequest({
    request_id: "req-account-rights-001",
    soft_preferences: [
      { field: "noise", priority: "high" },
      { field: "daylight", priority: "medium" },
    ],
    assumptions: ["合成假设：按非实时证据比较"],
    confirmed_by_user: true,
  });
}

function populatedState() {
  const empty = createEmptyAccountState({ accountId, createdAt: t0 });
  const profile = createSavedPreferenceProfile({
    accountId,
    request: request(),
    profileKind: "focus",
    createdAt: t0,
  });
  const withPreference = savePreferenceProfile(empty, profile, {
    confirmed: true,
    expectedVersion: 0,
    updatedAt: "2026-08-19T19:01:00+08:00",
  });
  const record = createAccountDecisionRecord({
    accountId,
    request: request(),
    outcome: "published",
    candidates: [{ place_id: "hp-omnibus", role: "primary" }],
    savedAt: "2026-08-19T19:01:30+08:00",
  });
  return saveAccountDecisionRecord(withPreference, record, {
    confirmed: true,
    expectedVersion: 1,
    updatedAt: "2026-08-19T19:02:00+08:00",
  });
}

test("returns a complete user data view only to the matching authorized account", () => {
  const state = populatedState();
  const view = createAccountDataView(state, {
    authorized: true,
    accountId,
    generatedAt: "2026-08-19T19:03:00+08:00",
  });
  assert.equal(view.account_state.preferences.length, 1);
  assert.equal(view.account_state.decisions.length, 1);
  assert.equal(view.raw_text_included, false);
  assert.equal(view.credential_included, false);
  assert.throws(() => createAccountDataView(state, {
    authorized: false,
    accountId,
    generatedAt: "2026-08-19T19:03:00+08:00",
  }), /ACCOUNT_DATA_ACCESS_UNAUTHORIZED/);
  assert.throws(() => createAccountDataView(state, {
    authorized: true,
    accountId: otherAccountId,
    generatedAt: "2026-08-19T19:03:00+08:00",
  }), /ACCOUNT_DATA_ACCOUNT_MISMATCH/);
});

test("edits only a matching saved preference with confirmation and version control", () => {
  const state = populatedState();
  const next = editAccountPreference(state, {
    profileId: state.preferences[0].profile_id,
    changes: {
      max_walk_minutes: 8,
      soft_preferences: [{ field: "noise", priority: "medium" }],
    },
  }, {
    authorized: true,
    accountId,
    confirmed: true,
    expectedVersion: 2,
    updatedAt: "2026-08-19T19:03:00+08:00",
  });
  assert.equal(next.version, 3);
  assert.equal(next.preferences[0].max_walk_minutes, 8);
  assert.deepEqual(next.preferences[0].soft_preferences, [{ field: "noise", priority: "medium" }]);
  assert.throws(() => editAccountPreference(state, {
    profileId: state.preferences[0].profile_id,
    changes: { account_id: otherAccountId },
  }, {
    authorized: true,
    accountId,
    confirmed: true,
    expectedVersion: 2,
    updatedAt: "2026-08-19T19:03:00+08:00",
  }), /ACCOUNT_PREFERENCE_EDIT_INVALID/);
});

test("exports all structured account data with integrity and no credentials", async () => {
  const state = populatedState();
  const dataExport = await createAccountDataExport(state, {
    authorized: true,
    accountId,
    confirmed: true,
    createdAt: "2026-08-19T19:03:00+08:00",
  });
  assert.equal(dataExport.portable_format, "json");
  assert.equal(dataExport.raw_text_included, false);
  assert.equal(dataExport.credential_included, false);
  assert.equal(await verifyAccountDataExport(dataExport), true);

  const tampered = structuredClone(dataExport);
  tampered.account_state.version += 1;
  await assert.rejects(() => verifyAccountDataExport(tampered), /ACCOUNT_DATA_EXPORT_CORRUPT/);
  await assert.rejects(() => createAccountDataExport(state, {
    authorized: true,
    accountId,
    confirmed: false,
    createdAt: "2026-08-19T19:03:00+08:00",
  }), /ACCOUNT_DATA_EXPORT_CONFIRMATION_REQUIRED/);
});

test("deletes preference and decision records without retaining deleted content", () => {
  const state = populatedState();
  const preferenceDeletion = deleteAccountDataRecord(state, {
    recordType: "preference",
    recordId: state.preferences[0].profile_id,
  }, {
    authorized: true,
    accountId,
    confirmed: true,
    expectedVersion: 2,
    updatedAt: "2026-08-19T19:03:00+08:00",
  });
  assert.equal(preferenceDeletion.account_state.preferences.length, 0);
  assert.equal(preferenceDeletion.receipt.deleted_record_content_retained, false);

  const decisionDeletion = deleteAccountDataRecord(preferenceDeletion.account_state, {
    recordType: "decision",
    recordId: state.decisions[0].history_id,
  }, {
    authorized: true,
    accountId,
    confirmed: true,
    expectedVersion: 3,
    updatedAt: "2026-08-19T19:04:00+08:00",
  });
  assert.equal(decisionDeletion.account_state.decisions.length, 0);
  assert.equal(decisionDeletion.account_state.version, 4);
});

test("requires a non-applying closure plan and final confirmation before account deletion", async () => {
  const state = populatedState();
  const plan = createAccountClosurePlan(state, {
    authorized: true,
    accountId,
    createdAt: "2026-08-19T19:03:00+08:00",
  });
  assert.equal(plan.status, "pending_user_confirmation");
  assert.equal(plan.automatic_apply_allowed, false);
  await assert.rejects(() => applyAccountClosure(state, plan, {
    authorized: true,
    accountId,
    confirmed: false,
    closedAt: "2026-08-19T19:04:00+08:00",
  }), /ACCOUNT_CLOSURE_CONFIRMATION_REQUIRED/);

  const closed = await applyAccountClosure(state, plan, {
    authorized: true,
    accountId,
    confirmed: true,
    closedAt: "2026-08-19T19:04:00+08:00",
  });
  assert.equal(closed.account_state, null);
  assert.equal(closed.receipt.deleted_preference_count, 1);
  assert.equal(closed.receipt.deleted_decision_count, 1);
  assert.equal(closed.receipt.account_content_retained, false);
  assert.equal(closed.receipt.closure_audit_digest_retained, true);
  assert.equal("account_id" in closed.receipt, false);
});

test("blocks stale and cross-account closure plans", async () => {
  const state = populatedState();
  const plan = createAccountClosurePlan(state, {
    authorized: true,
    accountId,
    createdAt: "2026-08-19T19:03:00+08:00",
  });
  const stale = structuredClone(plan);
  stale.expected_account_version = 1;
  await assert.rejects(() => applyAccountClosure(state, stale, {
    authorized: true,
    accountId,
    confirmed: true,
    closedAt: "2026-08-19T19:04:00+08:00",
  }), /ACCOUNT_CLOSURE_VERSION_CONFLICT/);
  const foreign = structuredClone(plan);
  foreign.account_id = otherAccountId;
  await assert.rejects(() => applyAccountClosure(state, foreign, {
    authorized: true,
    accountId,
    confirmed: true,
    closedAt: "2026-08-19T19:04:00+08:00",
  }), /ACCOUNT_CLOSURE_ACCOUNT_MISMATCH/);
});
