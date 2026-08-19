import Ajv from "ajv";

import {
  assertAuthorizedEvidenceRecord,
  authorizeEvidenceReviewOperation,
  reviewOperationContract,
} from "../../src/ai-native/evidence/reviewAccessControl.js";
import { assertReviewContract } from "../../src/ai-native/evidence/reviewWorkbenchContracts.js";

export const EVIDENCE_REVIEW_LEDGER_SCHEMA_VERSION = "1.1.0";
export const EVIDENCE_REVIEW_LEDGER_CONTEXT = "production";
export const EVIDENCE_REVIEW_BACKUP_SCHEMA_VERSION = "1.0.0";

const dateTimePattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$";
const hashPattern = "^[a-f0-9]{64}$";

export const evidenceReviewAuditEntrySchema = {
  $id: "https://quietlens.local/schema/evidence-review-audit-entry-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidenceReviewAuditEntry",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "sequence",
    "event_id",
    "command_id",
    "command_sha256",
    "previous_entry_sha256",
    "operation",
    "record_contract",
    "record_id",
    "record_sha256",
    "actor_id",
    "identity_subject_hash",
    "scope_id",
    "review_context",
    "occurred_at",
    "record",
    "entry_sha256",
  ],
  properties: {
    schema_version: { const: EVIDENCE_REVIEW_LEDGER_SCHEMA_VERSION },
    sequence: { type: "integer", minimum: 1 },
    event_id: { type: "string", pattern: "^audit-[a-f0-9]{16}$" },
    command_id: { type: "string", pattern: "^command-[a-f0-9]{16}$" },
    command_sha256: { type: "string", pattern: hashPattern },
    previous_entry_sha256: { type: ["string", "null"], pattern: hashPattern },
    operation: {
      enum: [
        "review_source",
        "review_candidate",
        "review_deduplication_cluster",
        "review_conflict",
        "create_release_draft",
        "publish_release",
        "request_rollback",
      ],
    },
    record_contract: { enum: ["EvidenceReviewDecision", "EvidenceReleaseRecord", "EvidenceRollbackRecord"] },
    record_id: { type: "string", pattern: "^(?:review|release|rollback)-[a-f0-9]{16}$" },
    record_sha256: { type: "string", pattern: hashPattern },
    actor_id: { type: "string", pattern: "^reviewer-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    identity_subject_hash: { type: "string", pattern: hashPattern },
    scope_id: { type: "string", pattern: "^evidence-[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$" },
    review_context: { const: EVIDENCE_REVIEW_LEDGER_CONTEXT },
    occurred_at: { type: "string", pattern: dateTimePattern },
    record: { type: "object" },
    entry_sha256: { type: "string", pattern: hashPattern },
  },
};

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validateAuditEntry = ajv.compile(evidenceReviewAuditEntrySchema);

const evidenceReviewBackupSchema = {
  $id: "https://quietlens.local/schema/evidence-review-audit-backup-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidenceReviewAuditBackup",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "backup_id",
    "ledger_schema_version",
    "review_context",
    "scope_id",
    "created_at",
    "ledger_version",
    "entry_count",
    "head_entry_sha256",
    "snapshot_sha256",
    "snapshot",
    "requires_human_restore",
  ],
  properties: {
    schema_version: { const: EVIDENCE_REVIEW_BACKUP_SCHEMA_VERSION },
    backup_id: { type: "string", pattern: "^backup-[a-f0-9]{16}$" },
    ledger_schema_version: { const: EVIDENCE_REVIEW_LEDGER_SCHEMA_VERSION },
    review_context: { const: EVIDENCE_REVIEW_LEDGER_CONTEXT },
    scope_id: { type: "string", pattern: "^evidence-[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$" },
    created_at: { type: "string", pattern: dateTimePattern },
    ledger_version: { type: "integer", minimum: 0 },
    entry_count: { type: "integer", minimum: 0 },
    head_entry_sha256: { type: ["string", "null"], pattern: hashPattern },
    snapshot_sha256: { type: "string", pattern: hashPattern },
    snapshot: { type: "object" },
    requires_human_restore: { const: true },
  },
};

const validateBackup = ajv.compile(evidenceReviewBackupSchema);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptySnapshot() {
  return {
    schema_version: EVIDENCE_REVIEW_LEDGER_SCHEMA_VERSION,
    review_context: EVIDENCE_REVIEW_LEDGER_CONTEXT,
    version: 0,
    entries: [],
  };
}

function recordId(record) {
  return record?.decision_id ?? record?.release_id ?? record?.rollback_id ?? null;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error("EVIDENCE_AUDIT_CRYPTO_UNAVAILABLE");
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function entryWithoutHash(entry) {
  const { entry_sha256: omitted, ...unsigned } = entry;
  return unsigned;
}

function assertSnapshotShape(snapshot) {
  const expectedKeys = ["entries", "review_context", "schema_version", "version"];
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(expectedKeys)
    || snapshot.schema_version !== EVIDENCE_REVIEW_LEDGER_SCHEMA_VERSION
    || snapshot.review_context !== EVIDENCE_REVIEW_LEDGER_CONTEXT
    || !Number.isInteger(snapshot.version)
    || snapshot.version < 0
    || !Array.isArray(snapshot.entries)
    || snapshot.version !== snapshot.entries.length) {
    throw new Error("EVIDENCE_AUDIT_LOG_CORRUPT");
  }
}

export async function verifyEvidenceReviewAuditSnapshot(snapshot) {
  try {
    assertSnapshotShape(snapshot);
    const eventIds = new Set();
    let previousHash = null;
    for (let index = 0; index < snapshot.entries.length; index += 1) {
      const entry = snapshot.entries[index];
      if (!validateAuditEntry(entry)
        || entry.sequence !== index + 1
        || entry.previous_entry_sha256 !== previousHash
        || eventIds.has(entry.event_id)
        || reviewOperationContract(entry.operation) !== entry.record_contract) {
        throw new Error("EVIDENCE_AUDIT_LOG_CORRUPT");
      }
      assertReviewContract(entry.record_contract, entry.record, entry.record_id);
      if (recordId(entry.record) !== entry.record_id) throw new Error("EVIDENCE_AUDIT_LOG_CORRUPT");
      if (await sha256(canonicalJson(entry.record)) !== entry.record_sha256) {
        throw new Error("EVIDENCE_AUDIT_LOG_CORRUPT");
      }
      if (await sha256(canonicalJson(entryWithoutHash(entry))) !== entry.entry_sha256) {
        throw new Error("EVIDENCE_AUDIT_LOG_CORRUPT");
      }
      eventIds.add(entry.event_id);
      previousHash = entry.entry_sha256;
    }
    return Object.freeze({ valid: true, version: snapshot.version, entry_count: snapshot.entries.length });
  } catch {
    throw new Error("EVIDENCE_AUDIT_LOG_CORRUPT");
  }
}

export function createInMemoryEvidenceReviewAuditStore(initialSnapshot = emptySnapshot()) {
  let snapshot = clone(initialSnapshot);
  return Object.freeze({
    storage_kind: "in_memory_test",
    async readSnapshot() {
      return clone(snapshot);
    },
    async appendIfVersion(expectedVersion, entry) {
      if (snapshot.version !== expectedVersion) throw new Error("EVIDENCE_AUDIT_CONCURRENT_WRITE");
      snapshot = {
        ...snapshot,
        version: snapshot.version + 1,
        entries: [...snapshot.entries, clone(entry)],
      };
      return clone(snapshot);
    },
  });
}

export async function appendEvidenceReviewAuditRecord({
  store,
  principal,
  operation,
  scopeId,
  occurredAt,
  record,
  commandId = null,
  command = null,
  expectedLedgerVersion = null,
}) {
  if (!store?.readSnapshot || !store?.appendIfVersion) throw new Error("EVIDENCE_AUDIT_STORE_UNAVAILABLE");
  assertAuthorizedEvidenceRecord({
    principal,
    operation,
    scopeId,
    reviewContext: EVIDENCE_REVIEW_LEDGER_CONTEXT,
    at: occurredAt,
    record,
  });
  const snapshot = await store.readSnapshot();
  await verifyEvidenceReviewAuditSnapshot(snapshot);
  const contract = reviewOperationContract(operation);
  const id = recordId(record);
  const commandValue = command ?? { operation, record_id: id, record };
  const commandHash = await sha256(canonicalJson(commandValue));
  const resolvedCommandId = commandId ?? `command-${commandHash.slice(0, 16)}`;
  if (!/^command-[a-f0-9]{16}$/.test(resolvedCommandId)) throw new Error("EVIDENCE_AUDIT_COMMAND_ID_INVALID");
  const existingCommand = snapshot.entries.find((entry) => entry.command_id === resolvedCommandId);
  if (existingCommand) {
    if (existingCommand.command_sha256 !== commandHash || existingCommand.actor_id !== principal.principal_id) {
      throw new Error("EVIDENCE_AUDIT_COMMAND_COLLISION");
    }
    return clone(existingCommand);
  }
  if (expectedLedgerVersion !== null && snapshot.version !== expectedLedgerVersion) {
    throw new Error("EVIDENCE_AUDIT_VERSION_CONFLICT");
  }
  const recordHash = await sha256(canonicalJson(record));
  const existingForOperation = snapshot.entries.find((entry) => entry.operation === operation && entry.record_id === id);
  if (existingForOperation) {
    if (existingForOperation.record_sha256 !== recordHash || existingForOperation.actor_id !== principal.principal_id) {
      throw new Error("EVIDENCE_AUDIT_RECORD_COLLISION");
    }
    return clone(existingForOperation);
  }
  const eventHash = await sha256(`${resolvedCommandId}|${commandHash}|${operation}|${id}|${recordHash}|${principal.principal_id}|${occurredAt}`);
  const entry = {
    schema_version: EVIDENCE_REVIEW_LEDGER_SCHEMA_VERSION,
    sequence: snapshot.version + 1,
    event_id: `audit-${eventHash.slice(0, 16)}`,
    command_id: resolvedCommandId,
    command_sha256: commandHash,
    previous_entry_sha256: snapshot.entries.at(-1)?.entry_sha256 ?? null,
    operation,
    record_contract: contract,
    record_id: id,
    record_sha256: recordHash,
    actor_id: principal.principal_id,
    identity_subject_hash: principal.identity_subject_hash,
    scope_id: scopeId,
    review_context: EVIDENCE_REVIEW_LEDGER_CONTEXT,
    occurred_at: occurredAt,
    record: clone(record),
    entry_sha256: "",
  };
  entry.entry_sha256 = await sha256(canonicalJson(entryWithoutHash(entry)));
  if (!validateAuditEntry(entry)) throw new Error("EVIDENCE_AUDIT_ENTRY_INVALID");
  await store.appendIfVersion(snapshot.version, entry);
  return clone(entry);
}

export async function readVerifiedEvidenceReviewAuditLog({ store, principal, scopeId, at }) {
  if (!store?.readSnapshot) throw new Error("EVIDENCE_AUDIT_STORE_UNAVAILABLE");
  authorizeEvidenceReviewOperation({
    principal,
    operation: "read_audit_log",
    scopeId,
    reviewContext: EVIDENCE_REVIEW_LEDGER_CONTEXT,
    at,
  });
  const snapshot = await store.readSnapshot();
  await verifyEvidenceReviewAuditSnapshot(snapshot);
  return clone(snapshot);
}

export async function createEvidenceReviewAuditBackup({ store, principal, scopeId, createdAt }) {
  const snapshot = await readVerifiedEvidenceReviewAuditLog({ store, principal, scopeId, at: createdAt });
  const snapshotHash = await sha256(canonicalJson(snapshot));
  const bundle = {
    schema_version: EVIDENCE_REVIEW_BACKUP_SCHEMA_VERSION,
    backup_id: `backup-${(await sha256(`${scopeId}|${createdAt}|${snapshotHash}`)).slice(0, 16)}`,
    ledger_schema_version: EVIDENCE_REVIEW_LEDGER_SCHEMA_VERSION,
    review_context: EVIDENCE_REVIEW_LEDGER_CONTEXT,
    scope_id: scopeId,
    created_at: createdAt,
    ledger_version: snapshot.version,
    entry_count: snapshot.entries.length,
    head_entry_sha256: snapshot.entries.at(-1)?.entry_sha256 ?? null,
    snapshot_sha256: snapshotHash,
    snapshot,
    requires_human_restore: true,
  };
  if (!validateBackup(bundle)) throw new Error("EVIDENCE_AUDIT_BACKUP_INVALID");
  return clone(bundle);
}

export async function verifyEvidenceReviewAuditBackup(bundle) {
  try {
    if (!validateBackup(bundle)) throw new Error("EVIDENCE_AUDIT_BACKUP_INVALID");
    await verifyEvidenceReviewAuditSnapshot(bundle.snapshot);
    if (bundle.ledger_version !== bundle.snapshot.version
      || bundle.entry_count !== bundle.snapshot.entries.length
      || bundle.head_entry_sha256 !== (bundle.snapshot.entries.at(-1)?.entry_sha256 ?? null)
      || bundle.snapshot_sha256 !== await sha256(canonicalJson(bundle.snapshot))) {
      throw new Error("EVIDENCE_AUDIT_BACKUP_INVALID");
    }
    return Object.freeze({
      valid: true,
      backup_id: bundle.backup_id,
      ledger_version: bundle.ledger_version,
      entry_count: bundle.entry_count,
    });
  } catch {
    throw new Error("EVIDENCE_AUDIT_BACKUP_INVALID");
  }
}

export async function prepareEvidenceReviewAuditRestore({
  store,
  principal,
  scopeId,
  at,
  backup,
}) {
  authorizeEvidenceReviewOperation({
    principal,
    operation: "prepare_audit_restore",
    scopeId,
    reviewContext: EVIDENCE_REVIEW_LEDGER_CONTEXT,
    at,
  });
  const current = await store.readSnapshot();
  await verifyEvidenceReviewAuditSnapshot(current);
  await verifyEvidenceReviewAuditBackup(backup);
  if (backup.scope_id !== scopeId) throw new Error("EVIDENCE_AUDIT_BACKUP_SCOPE_MISMATCH");
  const restoreHash = await sha256(`${backup.backup_id}|${current.version}|${backup.ledger_version}|${principal.principal_id}|${at}`);
  return Object.freeze({
    restore_plan_id: `restore-${restoreHash.slice(0, 16)}`,
    backup_id: backup.backup_id,
    scope_id: scopeId,
    current_ledger_version: current.version,
    target_ledger_version: backup.ledger_version,
    requested_by: principal.principal_id,
    requested_at: at,
    status: "pending_human_confirmation",
    automatic_apply_allowed: false,
  });
}
