import assert from "node:assert/strict";
import test from "node:test";

import {
  isLocalEvidenceReviewerAuthLocation,
  isLocalEvidenceReviewWorkbenchLocation,
} from "../src/ai-native/evidence/reviewWorkbenchEntry.js";
import {
  enrollReviewerTotp,
  normalizeReviewerSupabaseConfig,
  readReviewerAuthState,
  signInReviewer,
  verifyReviewerTotp,
} from "../src/ai-native/evidence/reviewerAuthClient.js";
import {
  SYNTHETIC_CANDIDATE_STATE,
  SYNTHETIC_PIPELINE_STATE,
  SYNTHETIC_REVIEWER_ID,
} from "../src/ai-native/evidence/reviewWorkbenchFixture.js";
import {
  buildEvidenceReviewWorkbench,
  createEvidenceReleaseDraft,
  createReviewDecision,
} from "../src/ai-native/evidence/reviewWorkbench.js";
import {
  REVIEW_WORKSPACE_STORAGE_KEY,
  appendSyntheticReviewDecision,
  clearSyntheticReviewWorkspace,
  loadSyntheticReviewWorkspace,
} from "../src/ai-native/evidence/reviewWorkbenchPersistence.js";
import { stableHexId } from "../src/ai-native/evidence/stableId.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function sourceDecision(reviewContext = "synthetic_fixture") {
  return createReviewDecision({
    subjectType: "source",
    subject: SYNTHETIC_PIPELINE_STATE.registry[0],
    reviewContext,
    outcome: "source_confirmed",
    reasonCode: "source_current",
    reviewerId: SYNTHETIC_REVIEWER_ID,
    reviewedAt: "2026-08-19T12:00:00+08:00",
    nextReviewDueAt: "2026-09-19",
  });
}

test("uses browser-safe deterministic record identifiers", () => {
  assert.match(stableHexId("QuietLens|审核"), /^[a-f0-9]{16}$/);
  assert.equal(stableHexId("QuietLens|审核"), stableHexId("QuietLens|审核"));
  assert.notEqual(stableHexId("QuietLens|审核"), stableHexId("QuietLens|发布"));
});

test("opens the operator workbench only on an explicit localhost URL", () => {
  assert.equal(isLocalEvidenceReviewWorkbenchLocation({ hostname: "127.0.0.1", search: "?workbench=evidence-review" }), true);
  assert.equal(isLocalEvidenceReviewWorkbenchLocation({ hostname: "localhost", search: "?workbench=evidence-review" }), true);
  assert.equal(isLocalEvidenceReviewWorkbenchLocation({ hostname: "quietlens.example", search: "?workbench=evidence-review" }), false);
  assert.equal(isLocalEvidenceReviewWorkbenchLocation({ hostname: "127.0.0.1", search: "" }), false);
});

test("opens reviewer Auth bootstrap only on its explicit localhost URL", () => {
  assert.equal(isLocalEvidenceReviewerAuthLocation({ hostname: "127.0.0.1", search: "?workbench=evidence-review-auth" }), true);
  assert.equal(isLocalEvidenceReviewerAuthLocation({ hostname: "quietlens.example", search: "?workbench=evidence-review-auth" }), false);
  assert.equal(isLocalEvidenceReviewerAuthLocation({ hostname: "localhost", search: "?workbench=evidence-review" }), false);
});

test("accepts only an official project URL and a browser publishable key", () => {
  const normalized = normalizeReviewerSupabaseConfig({
    projectUrl: "https://quietlensfixture.supabase.co/",
    publishableKey: `sb_publishable_${"p".repeat(40)}`,
  });
  assert.equal(normalized.project_url, "https://quietlensfixture.supabase.co");
  assert.throws(() => normalizeReviewerSupabaseConfig({
    projectUrl: "https://quietlens.example.com",
    publishableKey: `sb_publishable_${"p".repeat(40)}`,
  }), /REVIEWER_AUTH_CONFIG_INVALID/);
  assert.throws(() => normalizeReviewerSupabaseConfig({
    projectUrl: "https://quietlensfixture.supabase.co",
    publishableKey: `sb_secret_${"s".repeat(40)}`,
  }), /REVIEWER_AUTH_CONFIG_INVALID/);
});

test("requires TOTP AAL2 without retaining credentials or exposing the enrollment secret", async () => {
  let signedIn = false;
  let verified = false;
  const calls = [];
  const client = {
    auth: {
      async getSession() { return { data: { session: signedIn ? { user: { id: "fixture" } } : null }, error: null }; },
      async signInWithPassword(value) { calls.push({ operation: "sign_in", email: value.email }); signedIn = true; return { error: null }; },
      mfa: {
        async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: verified ? "aal2" : "aal1", nextLevel: "aal2" }, error: null }; },
        async listFactors() { return { data: { totp: [] }, error: null }; },
        async enroll() { return { data: { id: "factor-fixture", type: "totp", totp: { qr_code: "data:image/svg+xml;base64,fixture", secret: "must-not-return" } }, error: null }; },
        async challenge({ factorId }) { calls.push({ operation: "challenge", factorId }); return { data: { id: "challenge-fixture" }, error: null }; },
        async verify({ code }) { calls.push({ operation: "verify", code_length: code.length }); verified = true; return { error: null }; },
      },
    },
  };

  assert.equal((await readReviewerAuthState(client)).status, "signed_out");
  assert.equal((await signInReviewer(client, { email: "owner@example.com", password: "not-retained" })).status, "enrollment_required");
  const enrollment = await enrollReviewerTotp(client);
  assert.deepEqual(Object.keys(enrollment).sort(), ["factor_id", "qr_code"]);
  assert.doesNotMatch(JSON.stringify(enrollment), /must-not-return/);
  assert.equal((await verifyReviewerTotp(client, { factorId: enrollment.factor_id, code: "123456" })).status, "ready_aal2");
  assert.deepEqual(calls, [
    { operation: "sign_in", email: "owner@example.com" },
    { operation: "challenge", factorId: "factor-fixture" },
    { operation: "verify", code_length: 6 },
  ]);
});

test("persists only append-only synthetic review decisions", () => {
  const storage = memoryStorage();
  const decision = sourceDecision();
  assert.equal(loadSyntheticReviewWorkspace(storage).status, "empty");
  const saved = appendSyntheticReviewDecision(storage, decision);
  assert.equal(saved.decisions.length, 1);
  assert.equal(appendSyntheticReviewDecision(storage, decision).decisions.length, 1);
  assert.throws(() => appendSyntheticReviewDecision(storage, sourceDecision("production")), /PRODUCTION_REVIEW_PERSISTENCE_FORBIDDEN/);
  assert.throws(() => appendSyntheticReviewDecision(storage, { ...decision, reviewer_id: "reviewer-other" }), /REVIEW_DECISION_ID_COLLISION/);
  assert.equal(clearSyntheticReviewWorkspace(storage).status, "empty");
});

test("stops on corrupt local state instead of overwriting it", () => {
  const storage = memoryStorage();
  storage.setItem(REVIEW_WORKSPACE_STORAGE_KEY, "{not-json");
  const loaded = loadSyntheticReviewWorkspace(storage);
  assert.equal(loaded.status, "corrupt");
  assert.equal(loaded.decisions.length, 0);
  assert.throws(() => appendSyntheticReviewDecision(storage, sourceDecision()), /REVIEW_WORKSPACE_CORRUPT/);
});

test("drives the synthetic queue while keeping publication permanently blocked", () => {
  const workbench = buildEvidenceReviewWorkbench({
    pipelineState: SYNTHETIC_PIPELINE_STATE,
    candidateState: SYNTHETIC_CANDIDATE_STATE,
    reviewDecisions: [],
    reviewContext: "synthetic_fixture",
    today: "2026-08-19",
  });
  assert.deepEqual(workbench.metrics, {
    source_count: 3,
    source_review_due_count: 3,
    candidate_pending_count: 3,
    feedback_candidate_pending_count: 1,
    deduplication_pending_count: 1,
    conflict_pending_count: 1,
    unresolved_work_item_count: 9,
  });
  const release = createEvidenceReleaseDraft({
    evidenceVersion: "v1.0.0-fixture.local",
    pipelineState: SYNTHETIC_PIPELINE_STATE,
    candidateState: SYNTHETIC_CANDIDATE_STATE,
    reviewDecisions: [],
    inputMode: "synthetic_fixture",
    createdBy: SYNTHETIC_REVIEWER_ID,
    createdAt: "2026-08-19T12:00:00+08:00",
  });
  assert.equal(release.publish_ready, false);
  assert.ok(release.blocking_codes.includes("SYNTHETIC_INPUT_FORBIDDEN"));
  assert.equal(release.ai_is_factual_source, false);
});
