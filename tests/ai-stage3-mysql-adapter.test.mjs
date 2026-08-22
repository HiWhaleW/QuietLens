import assert from "node:assert/strict";
import test from "node:test";

import {
  STAGE3_MYSQL_CONSUMER_DATABASE,
  STAGE3_MYSQL_DDL,
  STAGE3_MYSQL_EVIDENCE_DATABASE,
  STAGE3_MYSQL_SQL,
  createStage3MySqlAdapterProfile,
  createStage3MySqlPersistenceAdapter,
  parseStage3MySqlConfig,
} from "../src/ai-native/persistence/mysqlStage3Adapter.js";
import { validateStage3PersistenceAdapterProfile } from "../src/ai-native/persistence/stage3PersistenceContracts.js";

function enabledConfig() {
  return parseStage3MySqlConfig({
    QUIETLENS_STAGE3_MYSQL_ENABLED: "true",
    QUIETLENS_STAGE3_MYSQL_REGION: "cn-shanghai",
    QUIETLENS_STAGE3_MYSQL_CONSUMER_DATABASE: STAGE3_MYSQL_CONSUMER_DATABASE,
    QUIETLENS_STAGE3_MYSQL_EVIDENCE_DATABASE: STAGE3_MYSQL_EVIDENCE_DATABASE,
  });
}

function createFakeDriver(database, namespace) {
  let rows = [];
  const calls = [];
  function clone(value) {
    return structuredClone(value);
  }
  async function execute(statement, params) {
    calls.push({ statement, params: clone(params) });
    if (namespace === "consumer_runtime") {
      if (statement === STAGE3_MYSQL_SQL.consumer.selectRecordForUpdate) {
        return { rows: clone(rows.filter((row) => row.record_id === params[0])) };
      }
      if (statement === STAGE3_MYSQL_SQL.consumer.insertRecord) {
        rows.push({
          record_id: params[0], request_id: params[1], participant_id: params[2], record_type: params[3],
          payload_json: params[4], payload_sha256: params[5], recorded_at: params[6], expires_at: params[7],
        });
        return { affectedRows: 1 };
      }
      if (statement === STAGE3_MYSQL_SQL.consumer.listByRequestId) {
        return { rows: clone(rows.filter((row) => row.request_id === params[0]).sort((a, b) => a.record_id.localeCompare(b.record_id))) };
      }
      if (statement === STAGE3_MYSQL_SQL.consumer.listByParticipantId) {
        return { rows: clone(rows.filter((row) => row.participant_id === params[0]).sort((a, b) => a.record_id.localeCompare(b.record_id))) };
      }
      if (statement === STAGE3_MYSQL_SQL.consumer.deleteByRecordId) {
        const before = rows.length;
        rows = rows.filter((row) => row.record_id !== params[0]);
        return { affectedRows: before - rows.length };
      }
      if (statement === STAGE3_MYSQL_SQL.consumer.countByRecordId) {
        return { rows: [{ record_count: rows.filter((row) => row.record_id === params[0]).length }] };
      }
      if (statement === STAGE3_MYSQL_SQL.consumer.deleteByParticipantId) {
        const before = rows.length;
        rows = rows.filter((row) => row.participant_id !== params[0]);
        return { affectedRows: before - rows.length };
      }
      if (statement === STAGE3_MYSQL_SQL.consumer.countByParticipantId) {
        return { rows: [{ record_count: rows.filter((row) => row.participant_id === params[0]).length }] };
      }
      if (statement === STAGE3_MYSQL_SQL.consumer.deleteByRequestId) {
        const before = rows.length;
        rows = rows.filter((row) => row.request_id !== params[0]);
        return { affectedRows: before - rows.length };
      }
      if (statement === STAGE3_MYSQL_SQL.consumer.countByRequestId) {
        return { rows: [{ record_count: rows.filter((row) => row.request_id === params[0]).length }] };
      }
      if (statement === STAGE3_MYSQL_SQL.consumer.deleteExpired) {
        const before = rows.length;
        rows = rows.filter((row) => Date.parse(row.expires_at) > Date.parse(params[0]));
        return { affectedRows: before - rows.length };
      }
    }
    if (namespace === "evidence_workflow") {
      if (statement === STAGE3_MYSQL_SQL.evidence.selectCollisionForUpdate) {
        return { rows: clone(rows.filter((row) => row.journal_entry_id === params[0] || row.idempotency_key === params[1])) };
      }
      if (statement === STAGE3_MYSQL_SQL.evidence.selectResumeEntryForUpdate) {
        return { rows: clone(rows.filter((row) => row.journal_entry_id === params[0])) };
      }
      if (statement === STAGE3_MYSQL_SQL.evidence.insertJournalEntry) {
        const payload = JSON.parse(params[8]);
        rows.push({
          journal_entry_id: params[0], workflow_run_id: params[1], idempotency_key: params[2],
          phase: params[3], status: params[4], source_id: params[5], review_status: params[6],
          signed_release_ref: params[7], payload_json: params[8], payload_sha256: params[9],
          recorded_at: params[10], expires_at: params[11], attempt: payload.attempt,
        });
        return { affectedRows: 1 };
      }
      if (statement === STAGE3_MYSQL_SQL.evidence.listByRunId) {
        return { rows: clone(rows.filter((row) => row.workflow_run_id === params[0])) };
      }
      if (statement === STAGE3_MYSQL_SQL.evidence.listBySourceId) {
        return { rows: clone(rows.filter((row) => row.source_id === params[0])) };
      }
      if (statement === STAGE3_MYSQL_SQL.evidence.listByStatus) {
        return { rows: clone(rows.filter((row) => row.status === params[0])) };
      }
      if (statement === STAGE3_MYSQL_SQL.evidence.listByReviewStatus) {
        return { rows: clone(rows.filter((row) => row.review_status === params[0])) };
      }
      if (statement === STAGE3_MYSQL_SQL.evidence.listByReleaseVersion) {
        return { rows: clone(rows.filter((row) => row.signed_release_ref === params[0])) };
      }
      if (statement === STAGE3_MYSQL_SQL.evidence.deleteByRecordId) {
        const before = rows.length;
        rows = rows.filter((row) => row.journal_entry_id !== params[0]);
        return { affectedRows: before - rows.length };
      }
      if (statement === STAGE3_MYSQL_SQL.evidence.countByRecordId) {
        return { rows: [{ record_count: rows.filter((row) => row.journal_entry_id === params[0]).length }] };
      }
      if (statement === STAGE3_MYSQL_SQL.evidence.deleteExpired) {
        const before = rows.length;
        rows = rows.filter((row) => Date.parse(row.expires_at) > Date.parse(params[0]));
        return { affectedRows: before - rows.length };
      }
    }
    throw new Error("UNEXPECTED_FAKE_SQL");
  }
  return {
    database,
    calls,
    snapshot: () => clone(rows),
    async transaction(callback) {
      const before = clone(rows);
      try {
        return await callback({ execute });
      } catch (error) {
        rows = before;
        throw error;
      }
    },
  };
}

function adapterFixture() {
  const consumer = createFakeDriver(STAGE3_MYSQL_CONSUMER_DATABASE, "consumer_runtime");
  const evidence = createFakeDriver(STAGE3_MYSQL_EVIDENCE_DATABASE, "evidence_workflow");
  const adapter = createStage3MySqlPersistenceAdapter({
    config: enabledConfig(),
    drivers: { consumer_runtime: consumer, evidence_workflow: evidence },
  });
  return { adapter, consumer, evidence };
}

function consumerRecord(overrides = {}) {
  return {
    record_id: "record-request-01",
    request_id: "request-01",
    participant_id: "beta-participant-01",
    record_type: "structured_decision_request",
    payload: { district: "黄浦", intent_summary: "安静工作" },
    recorded_at: "2026-08-21T10:00:00+08:00",
    expires_at: "2026-11-19T10:00:00+08:00",
    ...overrides,
  };
}

function accessPlan() {
  return {
    plan_id: "plan-bocha-weekly",
    storage: { stores_full_text: false, raw_retention_days: 0 },
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

test("is disabled by default and refuses partial or cross-region configuration", () => {
  assert.deepEqual(parseStage3MySqlConfig({}), { enabled: false });
  assert.throws(() => createStage3MySqlPersistenceAdapter(), { code: "MYSQL_STAGE3_DISABLED" });
  assert.throws(() => parseStage3MySqlConfig({
    QUIETLENS_STAGE3_MYSQL_ENABLED: "true",
    QUIETLENS_STAGE3_MYSQL_REGION: "cn-beijing",
  }), { code: "MYSQL_STAGE3_CONFIG_INVALID" });
});

test("builds a valid profile with two distinct database locators and no /tmp storage", () => {
  const profile = createStage3MySqlAdapterProfile(enabledConfig());
  assert.deepEqual(validateStage3PersistenceAdapterProfile(profile), { valid: true, issues: [] });
  assert.notEqual(profile.bindings.consumer_runtime.locator, profile.bindings.evidence_workflow.locator);
  assert.equal(profile.durable_records_use_vefaas_tmp, false);
  assert.match(STAGE3_MYSQL_DDL.consumer_runtime, /ENGINE=InnoDB/u);
  assert.match(STAGE3_MYSQL_DDL.evidence_workflow, /UNIQUE KEY uq_workflow_idempotency/u);
});

test("rejects a shared driver or a driver bound to the wrong database", () => {
  const shared = createFakeDriver(STAGE3_MYSQL_CONSUMER_DATABASE, "consumer_runtime");
  assert.throws(() => createStage3MySqlPersistenceAdapter({
    config: enabledConfig(),
    drivers: { consumer_runtime: shared, evidence_workflow: shared },
  }), { code: "MYSQL_STAGE3_DRIVER_INVALID" });

  const consumer = createFakeDriver(STAGE3_MYSQL_CONSUMER_DATABASE, "consumer_runtime");
  const wrongEvidence = createFakeDriver("quietlens_wrong", "evidence_workflow");
  assert.throws(() => createStage3MySqlPersistenceAdapter({
    config: enabledConfig(),
    drivers: { consumer_runtime: consumer, evidence_workflow: wrongEvidence },
  }), { code: "MYSQL_STAGE3_DRIVER_INVALID" });
});

test("writes consumer records idempotently and rejects same-id different-content collisions", async () => {
  const { adapter, consumer } = adapterFixture();
  assert.deepEqual(await adapter.putConsumerRecord(consumerRecord()), {
    inserted: true, idempotent: false, record_id: "record-request-01",
  });
  assert.deepEqual(await adapter.putConsumerRecord(consumerRecord()), {
    inserted: false, idempotent: true, record_id: "record-request-01",
  });
  await assert.rejects(
    adapter.putConsumerRecord(consumerRecord({ payload: { district: "静安" } })),
    { code: "MYSQL_STAGE3_IDEMPOTENCY_COLLISION" },
  );
  assert.equal(consumer.snapshot().length, 1);
});

test("blocks prohibited fields even when nested inside a consumer payload", async () => {
  const { adapter, consumer } = adapterFixture();
  await assert.rejects(
    adapter.putConsumerRecord(consumerRecord({ payload: { safe: { raw_natural_language: "不要保存" } } })),
    { code: "MYSQL_STAGE3_PROHIBITED_FIELD" },
  );
  await assert.rejects(
    adapter.putConsumerRecord(consumerRecord({ expires_at: "2026-11-20T10:00:00+08:00" })),
    { code: "MYSQL_STAGE3_RETENTION_INVALID" },
  );
  assert.equal(consumer.calls.length, 0);
});

test("queries by request and deletes only the selected participant with a zero-remnant check", async () => {
  const { adapter } = adapterFixture();
  await adapter.putConsumerRecord(consumerRecord());
  await adapter.putConsumerRecord(consumerRecord({
    record_id: "record-request-02",
    request_id: "request-02",
    participant_id: "beta-participant-02",
  }));
  assert.equal((await adapter.listConsumerRecordsByRequestId("request-01")).length, 1);
  assert.equal((await adapter.listConsumerRecordsByParticipantId("beta-participant-01")).length, 1);
  assert.deepEqual(await adapter.deleteConsumerRecordsByParticipantId("beta-participant-01"), {
    deleted_record_count: 1,
    remaining_record_count: 0,
  });
  assert.equal((await adapter.listConsumerRecordsByRequestId("request-01")).length, 0);
  assert.equal((await adapter.listConsumerRecordsByRequestId("request-02")).length, 1);
});

test("supports exact record/request deletion and deterministic consumer retention expiry", async () => {
  const { adapter } = adapterFixture();
  await adapter.putConsumerRecord(consumerRecord());
  await adapter.putConsumerRecord(consumerRecord({
    record_id: "record-request-02",
    request_id: "request-02",
    participant_id: "beta-participant-02",
  }));
  assert.equal((await adapter.deleteConsumerRecordById("record-request-01")).deleted_record_count, 1);
  assert.equal((await adapter.deleteConsumerRecordsByRequestId("request-02")).deleted_record_count, 1);
  await adapter.putConsumerRecord(consumerRecord({
    record_id: "record-request-03",
    request_id: "request-03",
    recorded_at: "2026-08-20T10:00:00+08:00",
    expires_at: "2026-08-21T10:00:00+08:00",
  }));
  assert.equal((await adapter.deleteExpiredConsumerRecords("2026-08-21T10:00:00+08:00")).deleted_record_count, 1);
});

test("keeps consumer and Evidence SQL on their isolated drivers", async () => {
  const { adapter, consumer, evidence } = adapterFixture();
  await adapter.putConsumerRecord(consumerRecord());
  await adapter.appendEvidenceJournalEntry(
    journalEntry(),
    accessPlan(),
    "2027-08-21T10:00:00+08:00",
  );
  assert.equal(consumer.calls.every(({ statement }) => !statement.includes("workflow_journal")), true);
  assert.equal(evidence.calls.every(({ statement }) => !statement.includes("consumer_records")), true);
});

test("appends Evidence journal entries idempotently and rejects key collisions", async () => {
  const { adapter, evidence } = adapterFixture();
  const first = journalEntry();
  assert.equal((await adapter.appendEvidenceJournalEntry(first, accessPlan(), "2027-08-21T10:00:00+08:00")).inserted, true);
  assert.equal((await adapter.appendEvidenceJournalEntry(first, accessPlan(), "2027-08-21T10:00:00+08:00")).idempotent, true);
  await assert.rejects(adapter.appendEvidenceJournalEntry(
    journalEntry({ journal_entry_id: "journal-collection-02" }),
    accessPlan(),
    "2027-08-21T10:00:00+08:00",
  ), { code: "MYSQL_STAGE3_IDEMPOTENCY_COLLISION" });
  assert.equal(evidence.snapshot().length, 1);
});

test("supports every advertised Evidence query index, exact deletion, and retention purge", async () => {
  const { adapter } = adapterFixture();
  await adapter.appendEvidenceJournalEntry(journalEntry(), accessPlan(), "2027-08-21T10:00:00+08:00");
  assert.equal((await adapter.listEvidenceJournalBySourceId("src-bocha-weekly")).length, 1);
  assert.equal((await adapter.listEvidenceJournalByStatus("succeeded")).length, 1);
  assert.equal((await adapter.listEvidenceJournalByReviewStatus("not_required")).length, 1);
  assert.equal((await adapter.listEvidenceJournalByReleaseVersion("release-evidence-v1-01")).length, 0);
  assert.equal((await adapter.deleteEvidenceJournalEntryById("journal-collection-01")).deleted_record_count, 1);

  await adapter.appendEvidenceJournalEntry(journalEntry(), accessPlan(), "2027-08-21T10:00:00+08:00");
  assert.equal((await adapter.deleteExpiredEvidenceJournal("2027-08-21T10:00:00+08:00")).deleted_record_count, 1);
  await assert.rejects(adapter.appendEvidenceJournalEntry(
    journalEntry(),
    accessPlan(),
    "2027-08-22T10:00:00+08:00",
  ), { code: "MYSQL_STAGE3_RETENTION_INVALID" });
});

test("requires an existing same-run checkpoint before appending a resumed journal attempt", async () => {
  const { adapter } = adapterFixture();
  const first = journalEntry({
    journal_entry_id: "journal-collection-failed-01",
    idempotency_key: "idem-collection-attempt-01",
    status: "retryable_failed",
    retry_not_before_at: "2026-08-21T11:00:00+08:00",
    error_code: "PROVIDER_RATE_LIMITED",
  });
  const resumed = journalEntry({
    journal_entry_id: "journal-collection-resumed-02",
    idempotency_key: "idem-collection-attempt-02",
    attempt: 2,
    resumed_from_entry_id: first.journal_entry_id,
  });
  await assert.rejects(adapter.appendEvidenceJournalEntry(
    resumed,
    accessPlan(),
    "2027-08-21T10:00:00+08:00",
  ), { code: "MYSQL_STAGE3_RESUME_CHAIN_INVALID" });
  await adapter.appendEvidenceJournalEntry(first, accessPlan(), "2027-08-21T10:00:00+08:00");
  assert.equal((await adapter.appendEvidenceJournalEntry(
    resumed,
    accessPlan(),
    "2027-08-21T10:00:00+08:00",
  )).inserted, true);
  assert.deepEqual(
    (await adapter.listEvidenceJournalByRunId("wf-run-weekly-01")).map(({ journal_entry_id }) => journal_entry_id),
    ["journal-collection-failed-01", "journal-collection-resumed-02"],
  );
});

test("fails closed on driver exceptions without exposing provider error text", async () => {
  const consumer = {
    database: STAGE3_MYSQL_CONSUMER_DATABASE,
    async transaction() {
      throw new Error("mysql://user:secret@example.invalid/private");
    },
  };
  const evidence = createFakeDriver(STAGE3_MYSQL_EVIDENCE_DATABASE, "evidence_workflow");
  const adapter = createStage3MySqlPersistenceAdapter({
    config: enabledConfig(),
    drivers: { consumer_runtime: consumer, evidence_workflow: evidence },
  });
  await assert.rejects(adapter.putConsumerRecord(consumerRecord()), (error) => {
    assert.equal(error.code, "MYSQL_STAGE3_DRIVER_FAILED");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
});
