import Ajv from "ajv";

import { authorizeEvidenceReviewOperation } from "../../src/ai-native/evidence/reviewAccessControl.js";
import { buildSafeEvidenceReviewProjection } from "../../src/ai-native/evidence/reviewSafeView.js";
import {
  buildEvidenceReviewWorkbench,
  createReviewDecision,
} from "../../src/ai-native/evidence/reviewWorkbench.js";
import {
  appendEvidenceReviewAuditRecord,
  verifyEvidenceReviewAuditSnapshot,
} from "../evidence/reviewAuditLedger.js";

export const EVIDENCE_REVIEW_COMMAND_SCHEMA_VERSION = "1.0.0";

const reviewCommandSchema = {
  $id: "https://quietlens.local/schema/evidence-review-command-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidenceReviewCommand",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "command_id",
    "expected_ledger_version",
    "subject_type",
    "subject_id",
    "outcome",
    "selected_candidate_id",
    "reason_code",
    "next_review_due_at",
  ],
  properties: {
    schema_version: { const: EVIDENCE_REVIEW_COMMAND_SCHEMA_VERSION },
    command_id: { type: "string", pattern: "^command-[a-f0-9]{16}$" },
    expected_ledger_version: { type: "integer", minimum: 0 },
    subject_type: { enum: ["source", "candidate", "deduplication_cluster", "conflict"] },
    subject_id: { type: "string", pattern: "^(?:src-[a-z0-9]+(?:-[a-z0-9]+)*|cand-[a-f0-9]{16}|dedup-[a-f0-9]{16}|conflict-[a-f0-9]{16})$" },
    outcome: { type: "string", minLength: 1, maxLength: 80 },
    selected_candidate_id: { type: ["string", "null"], pattern: "^cand-[a-f0-9]{16}$" },
    reason_code: { type: "string", minLength: 1, maxLength: 80 },
    next_review_due_at: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  },
};

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validateCommand = ajv.compile(reviewCommandSchema);

const operationBySubject = Object.freeze({
  source: "review_source",
  candidate: "review_candidate",
  deduplication_cluster: "review_deduplication_cluster",
  conflict: "review_conflict",
});

function assertCommand(command) {
  if (!validateCommand(command)) throw new Error("EVIDENCE_REVIEW_COMMAND_INVALID");
  return command;
}

function subjectFromState(subjectType, subjectId, pipelineState, candidateState) {
  if (subjectType === "source") return (pipelineState?.registry ?? []).find((item) => item.source_id === subjectId) ?? null;
  if (subjectType === "candidate") return (candidateState?.candidates ?? []).find((item) => item.candidate_id === subjectId) ?? null;
  if (subjectType === "deduplication_cluster") {
    return (candidateState?.deduplication_clusters ?? []).find((item) => item.cluster_id === subjectId) ?? null;
  }
  if (subjectType === "conflict") return (candidateState?.conflict_queue ?? []).find((item) => item.conflict_id === subjectId) ?? null;
  return null;
}

export async function queryEvidenceReviewWorkspace({
  principal,
  scopeId,
  at,
  today,
  pipelineState,
  candidateState,
  reviewDecisions = [],
}) {
  authorizeEvidenceReviewOperation({
    principal,
    operation: "read_review_workspace",
    scopeId,
    reviewContext: "production",
    at,
  });
  const workbench = buildEvidenceReviewWorkbench({
    pipelineState,
    candidateState,
    reviewDecisions,
    reviewContext: "production",
    today,
  });
  return buildSafeEvidenceReviewProjection({ scopeId, workbench, candidateState });
}

export async function executeEvidenceReviewCommand({
  principal,
  command,
  scopeId,
  at,
  pipelineState,
  candidateState,
  auditStore,
}) {
  assertCommand(command);
  if (!auditStore?.readSnapshot || !auditStore?.appendIfVersion) throw new Error("EVIDENCE_AUDIT_STORE_UNAVAILABLE");
  const operation = operationBySubject[command.subject_type];
  authorizeEvidenceReviewOperation({ principal, operation, scopeId, reviewContext: "production", at });
  const subject = subjectFromState(command.subject_type, command.subject_id, pipelineState, candidateState);
  if (!subject) throw new Error("EVIDENCE_REVIEW_SUBJECT_NOT_FOUND");
  const snapshot = await auditStore.readSnapshot();
  await verifyEvidenceReviewAuditSnapshot(snapshot);
  const existingCommand = snapshot.entries.some((entry) => entry.command_id === command.command_id);
  const decision = createReviewDecision({
    subjectType: command.subject_type,
    subject,
    reviewContext: "production",
    outcome: command.outcome,
    selectedCandidateId: command.selected_candidate_id,
    reasonCode: command.reason_code,
    reviewerId: principal.principal_id,
    reviewedAt: at,
    nextReviewDueAt: command.next_review_due_at,
  });
  const entry = await appendEvidenceReviewAuditRecord({
    store: auditStore,
    principal,
    operation,
    scopeId,
    occurredAt: at,
    record: decision,
    commandId: command.command_id,
    command,
    expectedLedgerVersion: command.expected_ledger_version,
  });
  return Object.freeze({
    command_id: entry.command_id,
    ledger_version: entry.sequence,
    idempotent_replay: existingCommand,
    decision: Object.freeze({ ...entry.record }),
    audit: Object.freeze({
      event_id: entry.event_id,
      entry_sha256: entry.entry_sha256,
      previous_entry_sha256: entry.previous_entry_sha256,
    }),
  });
}

export function validateEvidenceReviewCommand(command) {
  const valid = validateCommand(command);
  return { valid: Boolean(valid), errors: valid ? [] : [...(validateCommand.errors ?? [])] };
}
