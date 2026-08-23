import Ajv from "ajv";

export const STAGE3_PERSISTENCE_SCHEMA_VERSION = "1.0.0";

const dateTimePattern = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$";
const workflowRunIdPattern = "^wf-run-[a-z0-9]+(?:-[a-z0-9]+)*$";
const journalEntryIdPattern = "^journal-[a-z0-9]+(?:-[a-z0-9]+)*$";
const sourceIdPattern = "^src-[a-z0-9]+(?:-[a-z0-9]+)*$";
const planIdPattern = "^plan-[a-z0-9]+(?:-[a-z0-9]+)*$";

export const STAGE3_PERSISTENCE_CAPABILITIES = Object.freeze([
  "append_only_journal",
  "atomic_write",
  "conditional_write",
  "durable_write",
  "exact_delete_by_participant_id",
  "exact_delete_by_record_id",
  "exact_delete_by_request_id",
  "idempotency_unique_constraint",
  "query_by_participant_id",
  "query_by_request_id",
  "query_by_review_status",
  "query_by_run_id",
  "query_by_source_id",
  "query_by_status",
  "query_by_release_version",
  "retention_expiry",
]);

const CONSUMER_RUNTIME_CAPABILITIES = Object.freeze([
  "atomic_write",
  "conditional_write",
  "durable_write",
  "exact_delete_by_participant_id",
  "exact_delete_by_record_id",
  "exact_delete_by_request_id",
  "idempotency_unique_constraint",
  "query_by_participant_id",
  "query_by_request_id",
  "retention_expiry",
]);

const EVIDENCE_WORKFLOW_CAPABILITIES = Object.freeze([
  "append_only_journal",
  "atomic_write",
  "conditional_write",
  "durable_write",
  "exact_delete_by_record_id",
  "idempotency_unique_constraint",
  "query_by_review_status",
  "query_by_run_id",
  "query_by_source_id",
  "query_by_status",
  "query_by_release_version",
  "retention_expiry",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const STAGE3_PERSISTENCE_MANIFEST = deepFreeze({
  schema_version: STAGE3_PERSISTENCE_SCHEMA_VERSION,
  stage: "stage-3-wave-0",
  physical_product_sharing_allowed: true,
  shared_table_or_prefix_allowed: false,
  cross_namespace_write_allowed: false,
  runtime_filesystem_is_durable: false,
  namespaces: {
    consumer_runtime: {
      namespace_prefix: "quietlens_consumer_runtime_v1",
      authority: "consumer_operational_records",
      contract_refs: [
        "AnalyticsEvent@1.0.0",
        "DecisionCostRetentionBatch@1.0.0",
        "FeedbackSessionRecord@1.0.0",
        "FeedbackDeletionReceipt@1.0.0",
        "BetaParticipantDataDeletionReceipt@1.0.0",
      ],
      record_types: [
        "beta_admission_digest",
        "beta_session_record",
        "structured_decision_request",
        "analytics_event",
        "decision_cost_retention_batch",
        "feedback_session_record",
        "deletion_receipt",
      ],
      prohibited_fields: [
        "invite_code",
        "session_secret",
        "raw_natural_language",
        "original_phrase",
        "email",
        "phone",
        "contact_details",
        "precise_personal_location",
        "latitude",
        "longitude",
        "chain_of_thought",
        "raw_model_response",
        "raw_provider_response",
      ],
      retention: {
        default_max_days: 90,
        cost_record_days: 90,
        participant_expiry_or_deletion_enforced: true,
      },
      idempotency_keys: ["record_id", "request_id"],
      required_capabilities: CONSUMER_RUNTIME_CAPABILITIES,
      backup_restore: {
        encrypted_backup_required: true,
        cross_fault_domain_copy_required: true,
        isolated_restore_required: true,
        restore_integrity_check_required: true,
      },
      enters_evidence_authority: false,
    },
    evidence_workflow: {
      namespace_prefix: "quietlens_evidence_workflow_v1",
      authority: "evidence_workflow_journal_and_review",
      contract_refs: [
        "SourceAccessPlan@1.0.0",
        "CollectionRun@1.0.0",
        "RawSnapshot@1.0.0",
        "CandidateEvidenceRecord@1.0.0",
        "ConflictQueueItem@1.0.0",
        "FeedbackCandidateRecord@1.0.0",
        "ReviewDecision@1.0.0",
        "EvidenceReleaseRecord@1.0.0",
        "EvidenceRollbackRecord@1.0.0",
      ],
      record_types: [
        "workflow_journal_entry",
        "collection_run",
        "raw_snapshot_reference",
        "candidate_evidence_record",
        "conflict_queue_item",
        "feedback_candidate_record",
        "review_decision",
        "signed_release_reference",
        "rollback_record",
      ],
      prohibited_fields: [
        "invite_code",
        "participant_id",
        "email",
        "phone",
        "precise_personal_location",
        "chain_of_thought",
        "provider_response_body",
      ],
      retention: {
        journal_days: 365,
        provider_payload_follows_source_access_plan: true,
        withdrawn_or_forbidden_payload_delete_required: true,
      },
      idempotency_keys: ["idempotency_key", "journal_entry_id"],
      required_capabilities: EVIDENCE_WORKFLOW_CAPABILITIES,
      backup_restore: {
        encrypted_backup_required: true,
        cross_fault_domain_copy_required: true,
        isolated_restore_required: true,
        restore_integrity_check_required: true,
      },
      release_requires_human_review_and_signature: true,
    },
  },
  scheduler: {
    trigger_model: "external_trigger",
    weekly_schedule_required: true,
    resident_process_allowed: false,
    retry_delivery_required: true,
  },
});

const bindingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["locator", "isolated_access_scope", "capabilities"],
  properties: {
    locator: { type: "string", minLength: 3, maxLength: 240 },
    isolated_access_scope: { type: "boolean" },
    capabilities: {
      type: "array",
      uniqueItems: true,
      items: { enum: STAGE3_PERSISTENCE_CAPABILITIES },
    },
  },
};

export const stage3PersistenceAdapterProfileSchema = {
  $id: "https://quietlens.local/schema/stage3-persistence-adapter-profile-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Stage3PersistenceAdapterProfile",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "adapter_id",
    "provider",
    "durability_class",
    "bindings",
    "backup_restore",
    "scheduler",
    "durable_records_use_vefaas_tmp",
    "source_storage_policy_enforced",
  ],
  properties: {
    schema_version: { const: STAGE3_PERSISTENCE_SCHEMA_VERSION },
    adapter_id: { type: "string", pattern: "^persistence-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    provider: { type: "string", minLength: 1, maxLength: 120 },
    durability_class: { enum: ["durable", "ephemeral"] },
    bindings: {
      type: "object",
      additionalProperties: false,
      required: ["consumer_runtime", "evidence_workflow"],
      properties: {
        consumer_runtime: bindingSchema,
        evidence_workflow: bindingSchema,
      },
    },
    backup_restore: {
      type: "object",
      additionalProperties: false,
      required: [
        "encrypted_backup",
        "cross_fault_domain_copy",
        "isolated_restore",
        "restore_integrity_check",
      ],
      properties: {
        encrypted_backup: { type: "boolean" },
        cross_fault_domain_copy: { type: "boolean" },
        isolated_restore: { type: "boolean" },
        restore_integrity_check: { type: "boolean" },
      },
    },
    scheduler: {
      type: "object",
      additionalProperties: false,
      required: ["trigger_model", "weekly_schedule", "resident_process_required", "retry_delivery"],
      properties: {
        trigger_model: { enum: ["external_trigger", "resident_process", "none"] },
        weekly_schedule: { type: "boolean" },
        resident_process_required: { type: "boolean" },
        retry_delivery: { type: "boolean" },
      },
    },
    durable_records_use_vefaas_tmp: { type: "boolean" },
    source_storage_policy_enforced: { type: "boolean" },
  },
};

const outputRefSchema = {
  type: "object",
  additionalProperties: false,
  required: ["contract_name", "record_id"],
  properties: {
    contract_name: {
      enum: [
        "CollectionRun",
        "RawSnapshot",
        "CandidateEvidenceRecord",
        "ConflictQueueItem",
        "ReviewDecision",
        "EvidenceReleaseRecord",
        "EvidenceRollbackRecord",
      ],
    },
    record_id: { type: "string", minLength: 3, maxLength: 120 },
  },
};

export const evidenceWorkflowJournalEntrySchema = {
  $id: "https://quietlens.local/schema/evidence-workflow-journal-entry-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidenceWorkflowJournalEntry",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "journal_entry_id",
    "workflow_run_id",
    "idempotency_key",
    "phase",
    "status",
    "attempt",
    "recorded_at",
    "source_id",
    "access_plan_id",
    "checkpoint_ref",
    "resumed_from_entry_id",
    "retry_not_before_at",
    "error_code",
    "output_refs",
    "provider_response_storage",
    "provider_response_persisted_in_journal",
    "human_review_status",
    "signed_release_ref",
    "publish_allowed",
  ],
  properties: {
    schema_version: { const: STAGE3_PERSISTENCE_SCHEMA_VERSION },
    journal_entry_id: { type: "string", pattern: journalEntryIdPattern },
    workflow_run_id: { type: "string", pattern: workflowRunIdPattern },
    idempotency_key: { type: "string", pattern: "^idem-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    phase: {
      enum: [
        "scheduled",
        "source_access",
        "collection",
        "candidate_extraction",
        "conflict_queue",
        "human_review",
        "release",
        "rollback",
      ],
    },
    status: { enum: ["running", "succeeded", "retryable_failed", "blocked", "awaiting_human_review"] },
    attempt: { type: "integer", minimum: 1, maximum: 20 },
    recorded_at: { type: "string", pattern: dateTimePattern },
    source_id: { type: ["string", "null"], pattern: sourceIdPattern },
    access_plan_id: { type: ["string", "null"], pattern: planIdPattern },
    checkpoint_ref: { type: ["string", "null"], pattern: "^checkpoint:[a-z0-9]+(?:[-/:][a-z0-9]+)*$" },
    resumed_from_entry_id: { type: ["string", "null"], pattern: journalEntryIdPattern },
    retry_not_before_at: { type: ["string", "null"], pattern: dateTimePattern },
    error_code: { type: ["string", "null"], pattern: "^[A-Z][A-Z0-9_]+$" },
    output_refs: { type: "array", uniqueItems: true, items: outputRefSchema },
    provider_response_storage: {
      enum: ["none", "metadata_snapshot_ref", "authorized_payload_snapshot_ref"],
    },
    provider_response_persisted_in_journal: { const: false },
    human_review_status: { enum: ["not_required", "pending", "approved", "rejected"] },
    signed_release_ref: { type: ["string", "null"], minLength: 3, maxLength: 120 },
    publish_allowed: { type: "boolean" },
  },
};

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
const validateAdapterSchema = ajv.compile(stage3PersistenceAdapterProfileSchema);
const validateJournalEntrySchema = ajv.compile(evidenceWorkflowJournalEntrySchema);

function normalizeErrors(errors = []) {
  return errors.map((error) => ({
    code: "SCHEMA_INVALID",
    field: error.instancePath || "/",
    detail: error.message,
  }));
}

function issue(code, field, detail) {
  return { code, field, detail };
}

function containsEphemeralLocator(locator) {
  return /(?:^|[/:])(?:tmp|memory|in-memory|ephemeral)(?:$|[/:])/iu.test(locator)
    || locator.includes("/tmp/")
    || locator === "/tmp";
}

export function validateStage3PersistenceAdapterProfile(profile) {
  const validShape = validateAdapterSchema(profile);
  if (!validShape) return { valid: false, issues: normalizeErrors(validateAdapterSchema.errors) };

  const issues = [];
  if (profile.durability_class !== "durable") {
    issues.push(issue("DURABLE_STORE_REQUIRED", "durability_class", profile.durability_class));
  }
  if (profile.durable_records_use_vefaas_tmp) {
    issues.push(issue("VEFAAS_TMP_FORBIDDEN", "durable_records_use_vefaas_tmp", true));
  }
  if (!profile.source_storage_policy_enforced) {
    issues.push(issue("SOURCE_STORAGE_POLICY_REQUIRED", "source_storage_policy_enforced", false));
  }

  const consumer = profile.bindings.consumer_runtime;
  const evidence = profile.bindings.evidence_workflow;
  if (consumer.locator === evidence.locator) {
    issues.push(issue("NAMESPACE_LOCATOR_SHARED", "bindings", consumer.locator));
  }
  for (const [namespaceId, binding] of Object.entries(profile.bindings)) {
    if (!binding.isolated_access_scope) {
      issues.push(issue("NAMESPACE_ACCESS_NOT_ISOLATED", `bindings.${namespaceId}.isolated_access_scope`, false));
    }
    if (containsEphemeralLocator(binding.locator)) {
      issues.push(issue("EPHEMERAL_LOCATOR_FORBIDDEN", `bindings.${namespaceId}.locator`, binding.locator));
    }
    const required = STAGE3_PERSISTENCE_MANIFEST.namespaces[namespaceId].required_capabilities;
    const supported = new Set(binding.capabilities);
    for (const capability of required) {
      if (!supported.has(capability)) {
        issues.push(issue("CAPABILITY_MISSING", `bindings.${namespaceId}.capabilities`, capability));
      }
    }
  }

  for (const [field, enabled] of Object.entries(profile.backup_restore)) {
    if (!enabled) issues.push(issue("BACKUP_RESTORE_CAPABILITY_MISSING", `backup_restore.${field}`, false));
  }
  if (profile.scheduler.trigger_model !== "external_trigger"
    || !profile.scheduler.weekly_schedule
    || profile.scheduler.resident_process_required
    || !profile.scheduler.retry_delivery) {
    issues.push(issue("EXTERNAL_SCHEDULER_REQUIRED", "scheduler", profile.scheduler.trigger_model));
  }

  return { valid: issues.length === 0, issues };
}

function hasOutputRef(entry, contractName, recordId = null) {
  return entry.output_refs.some((ref) => ref.contract_name === contractName
    && (recordId === null || ref.record_id === recordId));
}

export function validateEvidenceWorkflowJournalEntry(entry, accessPlan = null) {
  const validShape = validateJournalEntrySchema(entry);
  if (!validShape) return { valid: false, issues: normalizeErrors(validateJournalEntrySchema.errors) };

  const issues = [];
  const sourcePhase = ["source_access", "collection", "candidate_extraction", "conflict_queue"].includes(entry.phase);
  if (sourcePhase && (!entry.source_id || !entry.access_plan_id)) {
    issues.push(issue("SOURCE_AND_PLAN_REQUIRED", "phase", entry.phase));
  }
  if (accessPlan && entry.access_plan_id !== accessPlan.plan_id) {
    issues.push(issue("ACCESS_PLAN_REFERENCE_MISMATCH", "access_plan_id", entry.access_plan_id));
  }
  if (["retryable_failed", "blocked"].includes(entry.status) && !entry.error_code) {
    issues.push(issue("ERROR_CODE_REQUIRED", "error_code", entry.status));
  }
  if (!["retryable_failed", "blocked"].includes(entry.status) && entry.error_code) {
    issues.push(issue("ERROR_CODE_UNEXPECTED", "error_code", entry.status));
  }
  if (entry.status === "retryable_failed" && !entry.retry_not_before_at) {
    issues.push(issue("RETRY_TIME_REQUIRED", "retry_not_before_at", entry.status));
  }
  if (entry.status !== "retryable_failed" && entry.retry_not_before_at) {
    issues.push(issue("RETRY_TIME_UNEXPECTED", "retry_not_before_at", entry.status));
  }
  if (entry.attempt > 1 && (!entry.resumed_from_entry_id || !entry.checkpoint_ref)) {
    issues.push(issue("RESUME_REFERENCE_REQUIRED", "attempt", entry.attempt));
  }
  if (entry.attempt === 1 && entry.resumed_from_entry_id) {
    issues.push(issue("RESUME_REFERENCE_UNEXPECTED", "resumed_from_entry_id", entry.resumed_from_entry_id));
  }
  if (entry.status === "awaiting_human_review"
    && (entry.phase !== "human_review" || entry.human_review_status !== "pending")) {
    issues.push(issue("HUMAN_REVIEW_STATE_INVALID", "human_review_status", entry.human_review_status));
  }

  if (entry.provider_response_storage !== "none") {
    if (!hasOutputRef(entry, "RawSnapshot")) {
      issues.push(issue("AUTHORIZED_SNAPSHOT_REFERENCE_REQUIRED", "output_refs", "RawSnapshot"));
    }
    const durableSnapshotAllowed = accessPlan?.storage?.raw_retention_days > 0;
    const fullPayloadAllowed = entry.provider_response_storage !== "authorized_payload_snapshot_ref"
      || accessPlan?.storage?.stores_full_text === true;
    if (!durableSnapshotAllowed || !fullPayloadAllowed) {
      issues.push(issue("PROVIDER_PAYLOAD_STORAGE_FORBIDDEN", "provider_response_storage", entry.access_plan_id));
    }
  }

  const releaseRefValid = entry.signed_release_ref
    && hasOutputRef(entry, "EvidenceReleaseRecord", entry.signed_release_ref);
  const releaseAuthorized = entry.phase === "release"
    && entry.status === "succeeded"
    && entry.human_review_status === "approved"
    && releaseRefValid;
  if (entry.publish_allowed !== Boolean(releaseAuthorized)) {
    issues.push(issue("PUBLISH_AUTHORIZATION_INVALID", "publish_allowed", entry.publish_allowed));
  }
  if (entry.signed_release_ref && !releaseRefValid) {
    issues.push(issue("SIGNED_RELEASE_REFERENCE_INVALID", "signed_release_ref", entry.signed_release_ref));
  }

  return { valid: issues.length === 0, issues };
}

export function validateEvidenceWorkflowJournal(entries, accessPlans = []) {
  if (!Array.isArray(entries) || !Array.isArray(accessPlans)) {
    return {
      valid: false,
      issues: [{ ...issue("JOURNAL_INPUT_INVALID", "/", "arrays required"), journal_entry_id: null }],
      metrics: {
        journal_entry_count: 0,
        workflow_run_count: 0,
        retry_entry_count: 0,
        publishable_release_count: 0,
      },
    };
  }
  const issues = [];
  const entryById = new Map();
  const idempotencyKeys = new Set();
  const planById = new Map(accessPlans.map((plan) => [plan.plan_id, plan]));

  for (const entry of entries) {
    const result = validateEvidenceWorkflowJournalEntry(entry, planById.get(entry?.access_plan_id) ?? null);
    for (const entryIssue of result.issues) {
      issues.push({ ...entryIssue, journal_entry_id: entry?.journal_entry_id ?? null });
    }
    if (entryById.has(entry?.journal_entry_id)) {
      issues.push({ ...issue("DUPLICATE_JOURNAL_ENTRY", "journal_entry_id", entry.journal_entry_id), journal_entry_id: entry.journal_entry_id });
    }
    if (idempotencyKeys.has(entry?.idempotency_key)) {
      issues.push({ ...issue("DUPLICATE_IDEMPOTENCY_KEY", "idempotency_key", entry.idempotency_key), journal_entry_id: entry?.journal_entry_id ?? null });
    }
    entryById.set(entry?.journal_entry_id, entry);
    idempotencyKeys.add(entry?.idempotency_key);
  }

  for (const entry of entries) {
    if (!entry?.resumed_from_entry_id) continue;
    const previous = entryById.get(entry.resumed_from_entry_id);
    if (!previous || previous.workflow_run_id !== entry.workflow_run_id || previous.attempt >= entry.attempt) {
      issues.push({
        ...issue("RESUME_CHAIN_INVALID", "resumed_from_entry_id", entry.resumed_from_entry_id),
        journal_entry_id: entry.journal_entry_id,
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    metrics: {
      journal_entry_count: entries.length,
      workflow_run_count: new Set(entries.map((entry) => entry.workflow_run_id)).size,
      retry_entry_count: entries.filter((entry) => entry.attempt > 1).length,
      publishable_release_count: entries.filter((entry) => entry.publish_allowed).length,
    },
  };
}
