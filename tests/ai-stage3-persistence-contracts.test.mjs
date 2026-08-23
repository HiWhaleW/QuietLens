import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGE3_PERSISTENCE_MANIFEST,
  validateEvidenceWorkflowJournal,
  validateEvidenceWorkflowJournalEntry,
  validateStage3PersistenceAdapterProfile,
} from "../src/ai-native/persistence/stage3PersistenceContracts.js";

function adapterProfile(overrides = {}) {
  const consumerCapabilities = [...STAGE3_PERSISTENCE_MANIFEST.namespaces.consumer_runtime.required_capabilities];
  const evidenceCapabilities = [...STAGE3_PERSISTENCE_MANIFEST.namespaces.evidence_workflow.required_capabilities];
  return {
    schema_version: "1.0.0",
    adapter_id: "persistence-synthetic-durable",
    provider: "synthetic-contract-fixture",
    durability_class: "durable",
    bindings: {
      consumer_runtime: {
        locator: "store://quietlens/consumer-runtime-v1",
        isolated_access_scope: true,
        capabilities: consumerCapabilities,
      },
      evidence_workflow: {
        locator: "store://quietlens/evidence-workflow-v1",
        isolated_access_scope: true,
        capabilities: evidenceCapabilities,
      },
    },
    backup_restore: {
      encrypted_backup: true,
      cross_fault_domain_copy: true,
      isolated_restore: true,
      restore_integrity_check: true,
    },
    scheduler: {
      trigger_model: "external_trigger",
      weekly_schedule: true,
      resident_process_required: false,
      retry_delivery: true,
    },
    durable_records_use_vefaas_tmp: false,
    source_storage_policy_enforced: true,
    ...overrides,
  };
}

function accessPlan(storage = {}) {
  return {
    plan_id: "plan-bocha-weekly",
    storage: {
      stores_full_text: false,
      raw_retention_days: 0,
      ...storage,
    },
  };
}

function journalEntry(overrides = {}) {
  return {
    schema_version: "1.0.0",
    journal_entry_id: "journal-collection-01",
    workflow_run_id: "wf-run-weekly-01",
    idempotency_key: "idem-collection-01",
    phase: "collection",
    status: "succeeded",
    attempt: 1,
    recorded_at: "2026-08-21T10:00:00+08:00",
    source_id: "src-bocha-weekly",
    access_plan_id: "plan-bocha-weekly",
    checkpoint_ref: "checkpoint:collection/01",
    resumed_from_entry_id: null,
    retry_not_before_at: null,
    error_code: null,
    output_refs: [{ contract_name: "CollectionRun", record_id: "run-bocha-weekly-01" }],
    provider_response_storage: "none",
    provider_response_persisted_in_journal: false,
    human_review_status: "not_required",
    signed_release_ref: null,
    publish_allowed: false,
    ...overrides,
  };
}

test("declares two isolated authorities without duplicating Evidence business contracts", () => {
  assert.deepEqual(Object.keys(STAGE3_PERSISTENCE_MANIFEST.namespaces), [
    "consumer_runtime",
    "evidence_workflow",
  ]);
  assert.equal(STAGE3_PERSISTENCE_MANIFEST.shared_table_or_prefix_allowed, false);
  assert.equal(STAGE3_PERSISTENCE_MANIFEST.cross_namespace_write_allowed, false);
  assert.equal(STAGE3_PERSISTENCE_MANIFEST.runtime_filesystem_is_durable, false);
  assert.equal(STAGE3_PERSISTENCE_MANIFEST.namespaces.consumer_runtime.enters_evidence_authority, false);
  assert.equal(
    STAGE3_PERSISTENCE_MANIFEST.namespaces.evidence_workflow.contract_refs.includes("CandidateEvidenceRecord@1.0.0"),
    true,
  );
});

test("accepts a provider-neutral durable adapter only when all required capabilities exist", () => {
  assert.deepEqual(validateStage3PersistenceAdapterProfile(adapterProfile()), { valid: true, issues: [] });
});

test("fails closed when logical namespaces share a locator or access scope", () => {
  const profile = adapterProfile();
  profile.bindings.evidence_workflow.locator = profile.bindings.consumer_runtime.locator;
  profile.bindings.evidence_workflow.isolated_access_scope = false;
  const result = validateStage3PersistenceAdapterProfile(profile);

  assert.equal(result.valid, false);
  assert.equal(result.issues.some(({ code }) => code === "NAMESPACE_LOCATOR_SHARED"), true);
  assert.equal(result.issues.some(({ code }) => code === "NAMESPACE_ACCESS_NOT_ISOLATED"), true);
});

test("rejects veFaaS /tmp, ephemeral stores, and missing precise deletion", () => {
  const profile = adapterProfile({
    durability_class: "ephemeral",
    durable_records_use_vefaas_tmp: true,
  });
  profile.bindings.consumer_runtime.locator = "/tmp/quietlens/consumer-runtime";
  profile.bindings.consumer_runtime.capabilities = profile.bindings.consumer_runtime.capabilities
    .filter((capability) => capability !== "exact_delete_by_participant_id");
  const result = validateStage3PersistenceAdapterProfile(profile);

  assert.equal(result.valid, false);
  for (const code of ["DURABLE_STORE_REQUIRED", "VEFAAS_TMP_FORBIDDEN", "EPHEMERAL_LOCATOR_FORBIDDEN", "CAPABILITY_MISSING"]) {
    assert.equal(result.issues.some((item) => item.code === code), true, code);
  }
});

test("requires encrypted dual-copy restore and an external retryable scheduler", () => {
  const profile = adapterProfile({
    backup_restore: {
      encrypted_backup: true,
      cross_fault_domain_copy: false,
      isolated_restore: false,
      restore_integrity_check: false,
    },
    scheduler: {
      trigger_model: "resident_process",
      weekly_schedule: true,
      resident_process_required: true,
      retry_delivery: false,
    },
  });
  const result = validateStage3PersistenceAdapterProfile(profile);

  assert.equal(result.valid, false);
  assert.equal(result.issues.filter(({ code }) => code === "BACKUP_RESTORE_CAPABILITY_MISSING").length, 3);
  assert.equal(result.issues.some(({ code }) => code === "EXTERNAL_SCHEDULER_REQUIRED"), true);
});

test("journal stores only business-record references and rejects provider payload fields", () => {
  const valid = validateEvidenceWorkflowJournalEntry(journalEntry(), accessPlan());
  assert.deepEqual(valid, { valid: true, issues: [] });

  const leaked = journalEntry({ provider_response_body: "must not persist" });
  const invalid = validateEvidenceWorkflowJournalEntry(leaked, accessPlan());
  assert.equal(invalid.valid, false);
  assert.equal(invalid.issues.some(({ code }) => code === "SCHEMA_INVALID"), true);
});

test("allows a RawSnapshot reference only when SourceAccessPlan permits payload persistence", () => {
  const entry = journalEntry({
    provider_response_storage: "authorized_payload_snapshot_ref",
    output_refs: [{ contract_name: "RawSnapshot", record_id: "snap-bocha-weekly-01" }],
  });
  const forbidden = validateEvidenceWorkflowJournalEntry(entry, accessPlan());
  const approved = validateEvidenceWorkflowJournalEntry(entry, accessPlan({ stores_full_text: true, raw_retention_days: 7 }));

  assert.equal(forbidden.valid, false);
  assert.equal(forbidden.issues.some(({ code }) => code === "PROVIDER_PAYLOAD_STORAGE_FORBIDDEN"), true);
  assert.deepEqual(approved, { valid: true, issues: [] });
});

test("keeps metadata snapshots distinct from authorized full provider payloads", () => {
  const entry = journalEntry({
    provider_response_storage: "metadata_snapshot_ref",
    output_refs: [{ contract_name: "RawSnapshot", record_id: "snap-bocha-metadata-01" }],
  });
  assert.deepEqual(
    validateEvidenceWorkflowJournalEntry(entry, accessPlan({ raw_retention_days: 7 })),
    { valid: true, issues: [] },
  );
  assert.equal(
    validateEvidenceWorkflowJournalEntry(entry, accessPlan({ raw_retention_days: 0 })).issues
      .some(({ code }) => code === "PROVIDER_PAYLOAD_STORAGE_FORBIDDEN"),
    true,
  );
});

test("requires deterministic retry checkpoints and validates the resume chain", () => {
  const first = journalEntry({
    journal_entry_id: "journal-collection-failed-01",
    idempotency_key: "idem-collection-attempt-01",
    status: "retryable_failed",
    error_code: "PROVIDER_RATE_LIMITED",
    retry_not_before_at: "2026-08-21T11:00:00+08:00",
  });
  const resumed = journalEntry({
    journal_entry_id: "journal-collection-resumed-02",
    idempotency_key: "idem-collection-attempt-02",
    attempt: 2,
    resumed_from_entry_id: first.journal_entry_id,
  });
  const valid = validateEvidenceWorkflowJournal([first, resumed], [accessPlan()]);
  assert.equal(valid.valid, true);
  assert.equal(valid.metrics.retry_entry_count, 1);

  const invalid = validateEvidenceWorkflowJournal([
    first,
    { ...resumed, resumed_from_entry_id: "journal-missing-previous" },
  ], [accessPlan()]);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.issues.some(({ code }) => code === "RESUME_CHAIN_INVALID"), true);
});

test("blocks release publication until human approval and a signed release record agree", () => {
  const unsigned = journalEntry({
    phase: "release",
    source_id: null,
    access_plan_id: null,
    human_review_status: "pending",
    publish_allowed: true,
  });
  const blocked = validateEvidenceWorkflowJournalEntry(unsigned);
  assert.equal(blocked.valid, false);
  assert.equal(blocked.issues.some(({ code }) => code === "PUBLISH_AUTHORIZATION_INVALID"), true);

  const approved = journalEntry({
    phase: "release",
    source_id: null,
    access_plan_id: null,
    human_review_status: "approved",
    signed_release_ref: "release-evidence-v1-01",
    output_refs: [{ contract_name: "EvidenceReleaseRecord", record_id: "release-evidence-v1-01" }],
    publish_allowed: true,
  });
  assert.deepEqual(validateEvidenceWorkflowJournalEntry(approved), { valid: true, issues: [] });
});
