import { createHash } from "node:crypto";

import {
  STAGE3_PERSISTENCE_MANIFEST,
  STAGE3_PERSISTENCE_SCHEMA_VERSION,
  validateEvidenceWorkflowJournalEntry,
  validateStage3PersistenceAdapterProfile,
} from "./stage3PersistenceContracts.js";

export const STAGE3_MYSQL_ADAPTER_ID = "persistence-volcengine-mysql-v1";
export const STAGE3_MYSQL_ENABLE_FLAG = "QUIETLENS_STAGE3_MYSQL_ENABLED";
export const STAGE3_MYSQL_CONSUMER_DATABASE = "quietlens_consumer_runtime_v1";
export const STAGE3_MYSQL_EVIDENCE_DATABASE = "quietlens_evidence_workflow_v1";

const CONSUMER_TABLE = "consumer_records";
const EVIDENCE_TABLE = "workflow_journal";
const RECORD_ID_PATTERN = /^[a-z][a-z0-9]+(?:[-_:][a-z0-9]+)*$/u;
const PARTICIPANT_ID_PATTERN = /^beta-participant-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REQUEST_ID_PATTERN = /^[a-z][a-z0-9]+(?:[-_:][a-z0-9]+)*$/u;
const EVIDENCE_QUERY_VALUE_PATTERN = /^[a-z0-9]+(?:[-_.:][a-z0-9]+)*$/u;

const prohibitedConsumerFields = new Set(
  STAGE3_PERSISTENCE_MANIFEST.namespaces.consumer_runtime.prohibited_fields,
);

export const STAGE3_MYSQL_SQL = Object.freeze({
  consumer: Object.freeze({
    selectRecordForUpdate: `SELECT record_id, payload_sha256, payload_json FROM ${CONSUMER_TABLE} WHERE record_id = ? FOR UPDATE`,
    insertRecord: `INSERT INTO ${CONSUMER_TABLE} (record_id, request_id, participant_id, record_type, payload_json, payload_sha256, recorded_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    listByRequestId: `SELECT record_id, request_id, participant_id, record_type, payload_json, recorded_at, expires_at FROM ${CONSUMER_TABLE} WHERE request_id = ? ORDER BY record_id ASC`,
    listByParticipantId: `SELECT record_id, request_id, participant_id, record_type, payload_json, recorded_at, expires_at FROM ${CONSUMER_TABLE} WHERE participant_id = ? ORDER BY record_id ASC`,
    deleteByRecordId: `DELETE FROM ${CONSUMER_TABLE} WHERE record_id = ?`,
    countByRecordId: `SELECT COUNT(*) AS record_count FROM ${CONSUMER_TABLE} WHERE record_id = ?`,
    deleteByParticipantId: `DELETE FROM ${CONSUMER_TABLE} WHERE participant_id = ?`,
    countByParticipantId: `SELECT COUNT(*) AS record_count FROM ${CONSUMER_TABLE} WHERE participant_id = ?`,
    deleteByRequestId: `DELETE FROM ${CONSUMER_TABLE} WHERE request_id = ?`,
    countByRequestId: `SELECT COUNT(*) AS record_count FROM ${CONSUMER_TABLE} WHERE request_id = ?`,
    deleteExpired: `DELETE FROM ${CONSUMER_TABLE} WHERE expires_at <= ?`,
  }),
  evidence: Object.freeze({
    selectCollisionForUpdate: `SELECT journal_entry_id, idempotency_key, workflow_run_id, attempt, payload_sha256, payload_json FROM ${EVIDENCE_TABLE} WHERE journal_entry_id = ? OR idempotency_key = ? FOR UPDATE`,
    selectResumeEntryForUpdate: `SELECT journal_entry_id, workflow_run_id, attempt, payload_json FROM ${EVIDENCE_TABLE} WHERE journal_entry_id = ? FOR UPDATE`,
    insertJournalEntry: `INSERT INTO ${EVIDENCE_TABLE} (journal_entry_id, workflow_run_id, idempotency_key, phase, status, source_id, review_status, signed_release_ref, payload_json, payload_sha256, recorded_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    listByRunId: `SELECT payload_json FROM ${EVIDENCE_TABLE} WHERE workflow_run_id = ? ORDER BY attempt ASC, recorded_at ASC, journal_entry_id ASC`,
    listBySourceId: `SELECT payload_json FROM ${EVIDENCE_TABLE} WHERE source_id = ? ORDER BY recorded_at ASC, journal_entry_id ASC`,
    listByStatus: `SELECT payload_json FROM ${EVIDENCE_TABLE} WHERE status = ? ORDER BY recorded_at ASC, journal_entry_id ASC`,
    listByReviewStatus: `SELECT payload_json FROM ${EVIDENCE_TABLE} WHERE review_status = ? ORDER BY recorded_at ASC, journal_entry_id ASC`,
    listByReleaseVersion: `SELECT payload_json FROM ${EVIDENCE_TABLE} WHERE signed_release_ref = ? ORDER BY recorded_at ASC, journal_entry_id ASC`,
    deleteByRecordId: `DELETE FROM ${EVIDENCE_TABLE} WHERE journal_entry_id = ?`,
    countByRecordId: `SELECT COUNT(*) AS record_count FROM ${EVIDENCE_TABLE} WHERE journal_entry_id = ?`,
    deleteExpired: `DELETE FROM ${EVIDENCE_TABLE} WHERE expires_at <= ?`,
  }),
});

export const STAGE3_MYSQL_DDL = Object.freeze({
  consumer_runtime: `CREATE TABLE ${CONSUMER_TABLE} (
  record_id VARCHAR(120) NOT NULL PRIMARY KEY,
  request_id VARCHAR(120) NULL,
  participant_id VARCHAR(120) NULL,
  record_type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  recorded_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  INDEX idx_consumer_request (request_id),
  INDEX idx_consumer_participant (participant_id),
  INDEX idx_consumer_expiry (expires_at)
) ENGINE=InnoDB`,
  evidence_workflow: `CREATE TABLE ${EVIDENCE_TABLE} (
  journal_entry_id VARCHAR(120) NOT NULL PRIMARY KEY,
  workflow_run_id VARCHAR(120) NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  phase VARCHAR(40) NOT NULL,
  status VARCHAR(40) NOT NULL,
  source_id VARCHAR(120) NULL,
  review_status VARCHAR(40) NOT NULL,
  signed_release_ref VARCHAR(120) NULL,
  payload_json JSON NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  recorded_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_workflow_idempotency (idempotency_key),
  INDEX idx_workflow_run (workflow_run_id),
  INDEX idx_workflow_source (source_id),
  INDEX idx_workflow_status (status),
  INDEX idx_workflow_review (review_status),
  INDEX idx_workflow_release (signed_release_ref),
  INDEX idx_workflow_expiry (expires_at)
) ENGINE=InnoDB`,
});

export class Stage3MySqlAdapterError extends Error {
  constructor(code) {
    super(code);
    this.name = "Stage3MySqlAdapterError";
    this.code = code;
  }
}

function fail(code) {
  throw new Stage3MySqlAdapterError(code);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function hashPayload(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseStoredJson(value) {
  if (value && typeof value === "object") return structuredClone(value);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") fail("MYSQL_STAGE3_STORED_RECORD_INVALID");
    return parsed;
  } catch (error) {
    if (error instanceof Stage3MySqlAdapterError) throw error;
    fail("MYSQL_STAGE3_STORED_RECORD_INVALID");
  }
}

function assertDateTime(value, code) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(code);
}

function findProhibitedField(value, seen = new Set()) {
  if (!value || typeof value !== "object") return null;
  if (seen.has(value)) return "cyclic_value";
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (prohibitedConsumerFields.has(key)) return key;
    const nested = findProhibitedField(child, seen);
    if (nested) return nested;
  }
  seen.delete(value);
  return null;
}

function isPlainJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? value : Object.values(value))
    .every((child) => isPlainJsonValue(child, seen));
  seen.delete(value);
  return valid;
}

function normalizeConsumerRecord(record) {
  const expectedKeys = [
    "expires_at",
    "participant_id",
    "payload",
    "record_id",
    "record_type",
    "recorded_at",
    "request_id",
  ];
  if (!record || typeof record !== "object" || Array.isArray(record)
    || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)
    || !RECORD_ID_PATTERN.test(record.record_id ?? "")
    || (record.request_id !== null && !REQUEST_ID_PATTERN.test(record.request_id ?? ""))
    || (record.participant_id !== null && !PARTICIPANT_ID_PATTERN.test(record.participant_id ?? ""))
    || !STAGE3_PERSISTENCE_MANIFEST.namespaces.consumer_runtime.record_types.includes(record.record_type)
    || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)
    || !isPlainJsonValue(record.payload)) {
    fail("MYSQL_STAGE3_CONSUMER_RECORD_INVALID");
  }
  assertDateTime(record.recorded_at, "MYSQL_STAGE3_CONSUMER_RECORD_INVALID");
  assertDateTime(record.expires_at, "MYSQL_STAGE3_CONSUMER_RECORD_INVALID");
  if (Date.parse(record.expires_at) <= Date.parse(record.recorded_at)) {
    fail("MYSQL_STAGE3_RETENTION_INVALID");
  }
  const consumerMaxMs = STAGE3_PERSISTENCE_MANIFEST.namespaces.consumer_runtime.retention.default_max_days
    * 24 * 60 * 60 * 1000;
  if (Date.parse(record.expires_at) - Date.parse(record.recorded_at) > consumerMaxMs) {
    fail("MYSQL_STAGE3_RETENTION_INVALID");
  }
  if (findProhibitedField(record.payload)) fail("MYSQL_STAGE3_PROHIBITED_FIELD");
  return structuredClone(record);
}

function assertQueryResult(result) {
  if (!result || typeof result !== "object" || !Array.isArray(result.rows)) {
    fail("MYSQL_STAGE3_DRIVER_RESULT_INVALID");
  }
  return result;
}

function assertMutationResult(result) {
  if (!result || typeof result !== "object" || !Number.isSafeInteger(result.affectedRows)
    || result.affectedRows < 0) {
    fail("MYSQL_STAGE3_DRIVER_RESULT_INVALID");
  }
  return result;
}

async function inTransaction(driver, callback) {
  try {
    return await driver.transaction(async (tx) => {
      if (!tx || typeof tx.execute !== "function") fail("MYSQL_STAGE3_DRIVER_INVALID");
      return callback(tx);
    });
  } catch (error) {
    if (error instanceof Stage3MySqlAdapterError) throw error;
    fail("MYSQL_STAGE3_DRIVER_FAILED");
  }
}

export function parseStage3MySqlConfig(env = {}) {
  if (env?.[STAGE3_MYSQL_ENABLE_FLAG] !== "true") return Object.freeze({ enabled: false });
  const config = {
    enabled: true,
    region: String(env.QUIETLENS_STAGE3_MYSQL_REGION ?? ""),
    consumer_database: String(env.QUIETLENS_STAGE3_MYSQL_CONSUMER_DATABASE ?? ""),
    evidence_database: String(env.QUIETLENS_STAGE3_MYSQL_EVIDENCE_DATABASE ?? ""),
  };
  if (config.region !== "cn-shanghai"
    || config.consumer_database !== STAGE3_MYSQL_CONSUMER_DATABASE
    || config.evidence_database !== STAGE3_MYSQL_EVIDENCE_DATABASE
    || config.consumer_database === config.evidence_database) {
    fail("MYSQL_STAGE3_CONFIG_INVALID");
  }
  return Object.freeze(config);
}

export function createStage3MySqlAdapterProfile(config) {
  if (!config?.enabled) fail("MYSQL_STAGE3_DISABLED");
  const profile = {
    schema_version: STAGE3_PERSISTENCE_SCHEMA_VERSION,
    adapter_id: STAGE3_MYSQL_ADAPTER_ID,
    provider: "volcengine-rds-mysql-conditional",
    durability_class: "durable",
    bindings: {
      consumer_runtime: {
        locator: `mysql://${config.region}/${config.consumer_database}`,
        isolated_access_scope: true,
        capabilities: [...STAGE3_PERSISTENCE_MANIFEST.namespaces.consumer_runtime.required_capabilities],
      },
      evidence_workflow: {
        locator: `mysql://${config.region}/${config.evidence_database}`,
        isolated_access_scope: true,
        capabilities: [...STAGE3_PERSISTENCE_MANIFEST.namespaces.evidence_workflow.required_capabilities],
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
  };
  const result = validateStage3PersistenceAdapterProfile(profile);
  if (!result.valid) fail("MYSQL_STAGE3_PROFILE_INVALID");
  return Object.freeze(profile);
}

function assertDriver(driver, database) {
  if (!driver || driver.database !== database || typeof driver.transaction !== "function") {
    fail("MYSQL_STAGE3_DRIVER_INVALID");
  }
}

export function createStage3MySqlPersistenceAdapter({ config, drivers } = {}) {
  if (!config?.enabled) fail("MYSQL_STAGE3_DISABLED");
  const profile = createStage3MySqlAdapterProfile(config);
  const consumerDriver = drivers?.consumer_runtime;
  const evidenceDriver = drivers?.evidence_workflow;
  assertDriver(consumerDriver, config.consumer_database);
  assertDriver(evidenceDriver, config.evidence_database);
  if (consumerDriver === evidenceDriver) fail("MYSQL_STAGE3_DRIVER_SCOPE_SHARED");

  async function listStoredRecords(driver, statement, value) {
    return inTransaction(driver, async (tx) => {
      const rows = assertQueryResult(await tx.execute(statement, [value])).rows;
      return Object.freeze(rows.map((row) => Object.freeze(parseStoredJson(row.payload_json))));
    });
  }

  async function deleteAndVerify(driver, deleteStatement, countStatement, value) {
    return inTransaction(driver, async (tx) => {
      const deleted = assertMutationResult(await tx.execute(deleteStatement, [value])).affectedRows;
      const remainingRows = assertQueryResult(await tx.execute(countStatement, [value])).rows;
      const remaining = remainingRows[0]?.record_count;
      if (!Number.isSafeInteger(remaining) || remaining < 0) fail("MYSQL_STAGE3_DRIVER_RESULT_INVALID");
      if (remaining !== 0) fail("MYSQL_STAGE3_DELETE_INCOMPLETE");
      return Object.freeze({ deleted_record_count: deleted, remaining_record_count: 0 });
    });
  }

  return Object.freeze({
    adapter_id: STAGE3_MYSQL_ADAPTER_ID,
    profile,

    async putConsumerRecord(input) {
      const record = normalizeConsumerRecord(input);
      const payloadHash = hashPayload(record);
      return inTransaction(consumerDriver, async (tx) => {
        const existing = assertQueryResult(
          await tx.execute(STAGE3_MYSQL_SQL.consumer.selectRecordForUpdate, [record.record_id]),
        ).rows;
        if (existing.length > 1) fail("MYSQL_STAGE3_STORED_RECORD_INVALID");
        if (existing.length === 1) {
          if (existing[0].payload_sha256 !== payloadHash) fail("MYSQL_STAGE3_IDEMPOTENCY_COLLISION");
          return Object.freeze({ inserted: false, idempotent: true, record_id: record.record_id });
        }
        assertMutationResult(await tx.execute(STAGE3_MYSQL_SQL.consumer.insertRecord, [
          record.record_id,
          record.request_id,
          record.participant_id,
          record.record_type,
          canonicalJson(record),
          payloadHash,
          record.recorded_at,
          record.expires_at,
        ]));
        return Object.freeze({ inserted: true, idempotent: false, record_id: record.record_id });
      });
    },

    async listConsumerRecordsByRequestId(requestId) {
      if (!REQUEST_ID_PATTERN.test(requestId ?? "")) fail("MYSQL_STAGE3_REQUEST_ID_INVALID");
      return listStoredRecords(consumerDriver, STAGE3_MYSQL_SQL.consumer.listByRequestId, requestId);
    },

    async listConsumerRecordsByParticipantId(participantId) {
      if (!PARTICIPANT_ID_PATTERN.test(participantId ?? "")) fail("MYSQL_STAGE3_PARTICIPANT_ID_INVALID");
      return listStoredRecords(consumerDriver, STAGE3_MYSQL_SQL.consumer.listByParticipantId, participantId);
    },

    async deleteConsumerRecordById(recordId) {
      if (!RECORD_ID_PATTERN.test(recordId ?? "")) fail("MYSQL_STAGE3_RECORD_ID_INVALID");
      return deleteAndVerify(
        consumerDriver,
        STAGE3_MYSQL_SQL.consumer.deleteByRecordId,
        STAGE3_MYSQL_SQL.consumer.countByRecordId,
        recordId,
      );
    },

    async deleteConsumerRecordsByParticipantId(participantId) {
      if (!PARTICIPANT_ID_PATTERN.test(participantId ?? "")) fail("MYSQL_STAGE3_PARTICIPANT_ID_INVALID");
      return deleteAndVerify(
        consumerDriver,
        STAGE3_MYSQL_SQL.consumer.deleteByParticipantId,
        STAGE3_MYSQL_SQL.consumer.countByParticipantId,
        participantId,
      );
    },

    async deleteConsumerRecordsByRequestId(requestId) {
      if (!REQUEST_ID_PATTERN.test(requestId ?? "")) fail("MYSQL_STAGE3_REQUEST_ID_INVALID");
      return deleteAndVerify(
        consumerDriver,
        STAGE3_MYSQL_SQL.consumer.deleteByRequestId,
        STAGE3_MYSQL_SQL.consumer.countByRequestId,
        requestId,
      );
    },

    async deleteExpiredConsumerRecords(cutoffAt) {
      assertDateTime(cutoffAt, "MYSQL_STAGE3_RETENTION_INVALID");
      return inTransaction(consumerDriver, async (tx) => Object.freeze({
        deleted_record_count: assertMutationResult(
          await tx.execute(STAGE3_MYSQL_SQL.consumer.deleteExpired, [cutoffAt]),
        ).affectedRows,
      }));
    },

    async appendEvidenceJournalEntry(entry, accessPlan = null, expiresAt) {
      const validation = validateEvidenceWorkflowJournalEntry(entry, accessPlan);
      if (!validation.valid) fail("MYSQL_STAGE3_JOURNAL_ENTRY_INVALID");
      if (!isPlainJsonValue(entry)) fail("MYSQL_STAGE3_JOURNAL_ENTRY_INVALID");
      assertDateTime(expiresAt, "MYSQL_STAGE3_RETENTION_INVALID");
      if (Date.parse(expiresAt) <= Date.parse(entry.recorded_at)) fail("MYSQL_STAGE3_RETENTION_INVALID");
      const evidenceMaxMs = STAGE3_PERSISTENCE_MANIFEST.namespaces.evidence_workflow.retention.journal_days
        * 24 * 60 * 60 * 1000;
      if (Date.parse(expiresAt) - Date.parse(entry.recorded_at) > evidenceMaxMs) {
        fail("MYSQL_STAGE3_RETENTION_INVALID");
      }
      const payloadHash = hashPayload(entry);
      return inTransaction(evidenceDriver, async (tx) => {
        const collisions = assertQueryResult(
          await tx.execute(STAGE3_MYSQL_SQL.evidence.selectCollisionForUpdate, [
            entry.journal_entry_id,
            entry.idempotency_key,
          ]),
        ).rows;
        if (collisions.length > 1) fail("MYSQL_STAGE3_IDEMPOTENCY_COLLISION");
        if (collisions.length === 1) {
          const existing = collisions[0];
          if (existing.journal_entry_id !== entry.journal_entry_id
            || existing.idempotency_key !== entry.idempotency_key
            || existing.payload_sha256 !== payloadHash) {
            fail("MYSQL_STAGE3_IDEMPOTENCY_COLLISION");
          }
          return Object.freeze({ inserted: false, idempotent: true, journal_entry_id: entry.journal_entry_id });
        }
        if (entry.resumed_from_entry_id) {
          const previousRows = assertQueryResult(
            await tx.execute(STAGE3_MYSQL_SQL.evidence.selectResumeEntryForUpdate, [entry.resumed_from_entry_id]),
          ).rows;
          const previous = previousRows[0];
          if (previousRows.length !== 1 || previous.workflow_run_id !== entry.workflow_run_id
            || !Number.isInteger(previous.attempt) || previous.attempt >= entry.attempt) {
            fail("MYSQL_STAGE3_RESUME_CHAIN_INVALID");
          }
        }
        assertMutationResult(await tx.execute(STAGE3_MYSQL_SQL.evidence.insertJournalEntry, [
          entry.journal_entry_id,
          entry.workflow_run_id,
          entry.idempotency_key,
          entry.phase,
          entry.status,
          entry.source_id,
          entry.human_review_status,
          entry.signed_release_ref,
          canonicalJson(entry),
          payloadHash,
          entry.recorded_at,
          expiresAt,
        ]));
        return Object.freeze({ inserted: true, idempotent: false, journal_entry_id: entry.journal_entry_id });
      });
    },

    async listEvidenceJournalByRunId(workflowRunId) {
      if (!/^wf-run-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(workflowRunId ?? "")) {
        fail("MYSQL_STAGE3_WORKFLOW_RUN_ID_INVALID");
      }
      return listStoredRecords(evidenceDriver, STAGE3_MYSQL_SQL.evidence.listByRunId, workflowRunId);
    },

    async listEvidenceJournalBySourceId(sourceId) {
      if (!/^src-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(sourceId ?? "")) fail("MYSQL_STAGE3_SOURCE_ID_INVALID");
      return listStoredRecords(evidenceDriver, STAGE3_MYSQL_SQL.evidence.listBySourceId, sourceId);
    },

    async listEvidenceJournalByStatus(status) {
      if (!EVIDENCE_QUERY_VALUE_PATTERN.test(status ?? "")) fail("MYSQL_STAGE3_STATUS_INVALID");
      return listStoredRecords(evidenceDriver, STAGE3_MYSQL_SQL.evidence.listByStatus, status);
    },

    async listEvidenceJournalByReviewStatus(reviewStatus) {
      if (!EVIDENCE_QUERY_VALUE_PATTERN.test(reviewStatus ?? "")) fail("MYSQL_STAGE3_REVIEW_STATUS_INVALID");
      return listStoredRecords(evidenceDriver, STAGE3_MYSQL_SQL.evidence.listByReviewStatus, reviewStatus);
    },

    async listEvidenceJournalByReleaseVersion(releaseRef) {
      if (!EVIDENCE_QUERY_VALUE_PATTERN.test(releaseRef ?? "")) fail("MYSQL_STAGE3_RELEASE_REF_INVALID");
      return listStoredRecords(evidenceDriver, STAGE3_MYSQL_SQL.evidence.listByReleaseVersion, releaseRef);
    },

    async deleteEvidenceJournalEntryById(journalEntryId) {
      if (!/^journal-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(journalEntryId ?? "")) {
        fail("MYSQL_STAGE3_JOURNAL_ENTRY_ID_INVALID");
      }
      return deleteAndVerify(
        evidenceDriver,
        STAGE3_MYSQL_SQL.evidence.deleteByRecordId,
        STAGE3_MYSQL_SQL.evidence.countByRecordId,
        journalEntryId,
      );
    },

    async deleteExpiredEvidenceJournal(cutoffAt) {
      assertDateTime(cutoffAt, "MYSQL_STAGE3_RETENTION_INVALID");
      return inTransaction(evidenceDriver, async (tx) => Object.freeze({
        deleted_record_count: assertMutationResult(
          await tx.execute(STAGE3_MYSQL_SQL.evidence.deleteExpired, [cutoffAt]),
        ).affectedRows,
      }));
    },
  });
}
