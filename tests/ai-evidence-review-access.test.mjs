import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_REVIEW_ACCESS_SCHEMA_VERSION,
  authorizeEvidenceReviewOperation,
  validateEvidenceReviewerPrincipal,
} from "../src/ai-native/evidence/reviewAccessControl.js";
import { createReviewDecision } from "../src/ai-native/evidence/reviewWorkbench.js";
import {
  appendEvidenceReviewAuditRecord,
  createInMemoryEvidenceReviewAuditStore,
  readVerifiedEvidenceReviewAuditLog,
  verifyEvidenceReviewAuditSnapshot,
} from "../worker/evidence/reviewAuditLedger.js";

const scopeId = "evidence-v1.0-huangpu-10";
const occurredAt = "2026-08-19T12:00:00+08:00";

function productionPrincipal(overrides = {}) {
  return {
    schema_version: EVIDENCE_REVIEW_ACCESS_SCHEMA_VERSION,
    principal_id: "reviewer-contract-fixture",
    actor_kind: "human",
    review_context: "production",
    identity_provider_id: "idp-contract-test",
    identity_subject_hash: "a".repeat(64),
    session_id_hash: "b".repeat(64),
    authentication_method: "external_identity",
    authentication_assurance: "multi_factor",
    roles: ["evidence_reviewer", "evidence_auditor"],
    scope_ids: [scopeId],
    authenticated_at: "2026-08-19T11:00:00+08:00",
    expires_at: "2026-08-19T13:00:00+08:00",
    status: "active",
    ai_is_actor: false,
    ...overrides,
  };
}

function sourceDecision(sourceId = "src-contract-fixture", reviewedAt = occurredAt) {
  return createReviewDecision({
    subjectType: "source",
    subject: { source_id: sourceId },
    reviewContext: "production",
    outcome: "source_confirmed",
    reasonCode: "source_current",
    reviewerId: "reviewer-contract-fixture",
    reviewedAt,
    nextReviewDueAt: "2026-09-19",
  });
}

test("requires an opaque multi-factor human principal for production review", () => {
  assert.equal(validateEvidenceReviewerPrincipal(productionPrincipal()).valid, true);
  assert.equal(validateEvidenceReviewerPrincipal(productionPrincipal({ authentication_assurance: "single_factor" })).valid, false);
  assert.equal(validateEvidenceReviewerPrincipal(productionPrincipal({ ai_is_actor: true })).valid, false);
  assert.equal(validateEvidenceReviewerPrincipal(productionPrincipal({ identity_provider_id: "idp-synthetic-fixture" })).valid, false);
});

test("denies expired, out-of-scope, wrong-context, and insufficient-role operations", () => {
  const principal = productionPrincipal({ roles: ["evidence_auditor"] });
  assert.throws(() => authorizeEvidenceReviewOperation({
    principal,
    operation: "review_source",
    scopeId,
    reviewContext: "production",
    at: occurredAt,
  }), /EVIDENCE_REVIEW_OPERATION_FORBIDDEN/);
  assert.throws(() => authorizeEvidenceReviewOperation({
    principal,
    operation: "read_audit_log",
    scopeId: "evidence-v1.0-other",
    reviewContext: "production",
    at: occurredAt,
  }), /EVIDENCE_REVIEW_SCOPE_FORBIDDEN/);
  assert.throws(() => authorizeEvidenceReviewOperation({
    principal,
    operation: "read_audit_log",
    scopeId,
    reviewContext: "synthetic_fixture",
    at: occurredAt,
  }), /EVIDENCE_REVIEW_CONTEXT_MISMATCH/);
  assert.throws(() => authorizeEvidenceReviewOperation({
    principal,
    operation: "read_audit_log",
    scopeId,
    reviewContext: "production",
    at: "2026-08-19T13:00:00+08:00",
  }), /EVIDENCE_REVIEW_SESSION_INVALID/);
});

test("appends and verifies a privacy-minimized production audit chain", async () => {
  const store = createInMemoryEvidenceReviewAuditStore();
  const principal = productionPrincipal();
  const decision = sourceDecision();
  const entry = await appendEvidenceReviewAuditRecord({
    store,
    principal,
    operation: "review_source",
    scopeId,
    occurredAt,
    record: decision,
  });
  assert.equal(entry.sequence, 1);
  assert.equal(entry.previous_entry_sha256, null);
  assert.equal(entry.identity_subject_hash, principal.identity_subject_hash);
  assert.equal(entry.record.reviewer_id, principal.principal_id);
  assert.equal("raw_identity_subject" in entry, false);

  const snapshot = await readVerifiedEvidenceReviewAuditLog({ store, principal, scopeId, at: occurredAt });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.entries.length, 1);
  assert.deepEqual(await verifyEvidenceReviewAuditSnapshot(snapshot), { valid: true, version: 1, entry_count: 1 });

  const replay = await appendEvidenceReviewAuditRecord({
    store,
    principal,
    operation: "review_source",
    scopeId,
    occurredAt,
    record: decision,
  });
  assert.equal(replay.entry_sha256, entry.entry_sha256);
  assert.equal((await store.readSnapshot()).version, 1);
});

test("rejects an actor mismatch and a same-ID record collision", async () => {
  const store = createInMemoryEvidenceReviewAuditStore();
  const principal = productionPrincipal();
  const decision = sourceDecision();
  await assert.rejects(() => appendEvidenceReviewAuditRecord({
    store,
    principal: productionPrincipal({ principal_id: "reviewer-other" }),
    operation: "review_source",
    scopeId,
    occurredAt,
    record: decision,
  }), /EVIDENCE_REVIEW_ACTOR_MISMATCH/);
  await appendEvidenceReviewAuditRecord({ store, principal, operation: "review_source", scopeId, occurredAt, record: decision });
  await assert.rejects(() => appendEvidenceReviewAuditRecord({
    store,
    principal,
    operation: "review_source",
    scopeId,
    occurredAt,
    record: { ...decision, next_review_due_at: "2026-10-19" },
  }), /EVIDENCE_AUDIT_RECORD_COLLISION/);
});

test("fails closed on a tampered audit record", async () => {
  const store = createInMemoryEvidenceReviewAuditStore();
  const principal = productionPrincipal();
  await appendEvidenceReviewAuditRecord({
    store,
    principal,
    operation: "review_source",
    scopeId,
    occurredAt,
    record: sourceDecision(),
  });
  const tampered = await store.readSnapshot();
  tampered.entries[0].record.next_review_due_at = "2026-10-19";
  const corruptStore = createInMemoryEvidenceReviewAuditStore(tampered);
  await assert.rejects(() => verifyEvidenceReviewAuditSnapshot(tampered), /EVIDENCE_AUDIT_LOG_CORRUPT/);
  await assert.rejects(() => appendEvidenceReviewAuditRecord({
    store: corruptStore,
    principal,
    operation: "review_source",
    scopeId,
    occurredAt: "2026-08-19T12:01:00+08:00",
    record: sourceDecision("src-contract-fixture-two", "2026-08-19T12:01:00+08:00"),
  }), /EVIDENCE_AUDIT_LOG_CORRUPT/);
});

test("allows only one writer when two appends race on the same ledger version", async () => {
  const store = createInMemoryEvidenceReviewAuditStore();
  const principal = productionPrincipal();
  const results = await Promise.allSettled([
    appendEvidenceReviewAuditRecord({
      store,
      principal,
      operation: "review_source",
      scopeId,
      occurredAt,
      record: sourceDecision("src-contract-race-one"),
    }),
    appendEvidenceReviewAuditRecord({
      store,
      principal,
      operation: "review_source",
      scopeId,
      occurredAt: "2026-08-19T12:00:01+08:00",
      record: sourceDecision("src-contract-race-two", "2026-08-19T12:00:01+08:00"),
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(results.find((result) => result.status === "rejected").reason.message, /EVIDENCE_AUDIT_CONCURRENT_WRITE/);
  assert.equal((await store.readSnapshot()).version, 1);
});

test("does not accept a synthetic browser principal in the production ledger", async () => {
  const store = createInMemoryEvidenceReviewAuditStore();
  const syntheticPrincipal = productionPrincipal({
    review_context: "synthetic_fixture",
    identity_provider_id: "idp-synthetic-fixture",
    authentication_method: "synthetic_fixture",
    authentication_assurance: "synthetic",
  });
  await assert.rejects(() => appendEvidenceReviewAuditRecord({
    store,
    principal: syntheticPrincipal,
    operation: "review_source",
    scopeId,
    occurredAt,
    record: sourceDecision(),
  }), /EVIDENCE_REVIEW_CONTEXT_MISMATCH/);
  assert.equal((await store.readSnapshot()).version, 0);
});
