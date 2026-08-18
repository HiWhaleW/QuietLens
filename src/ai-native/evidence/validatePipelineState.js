import { assertPipelineContract } from "./pipelineContracts.js";
import { AUTOMATED_ACCESS_MODES, validateSourceAccessPlan } from "./sourceAccessPolicy.js";

function addIssue(issues, code, recordId, detail) {
  issues.push({ code, record_id: recordId, detail });
}

function duplicates(records, field) {
  const seen = new Set();
  const repeated = new Set();
  for (const record of records) {
    if (seen.has(record[field])) repeated.add(record[field]);
    seen.add(record[field]);
  }
  return [...repeated];
}

function validateRecords(issues, name, records, idField) {
  for (const record of records) {
    try {
      assertPipelineContract(name, record, record[idField] ?? name);
    } catch (error) {
      addIssue(issues, "SCHEMA_INVALID", record[idField] ?? name, error.message);
    }
  }
  for (const duplicate of duplicates(records, idField)) {
    addIssue(issues, "DUPLICATE_ID", duplicate, idField);
  }
}

function sourceHost(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function validateEvidencePipelineState(state, evidenceStore) {
  const issues = [];
  const {
    manifest,
    registry = [],
    access_plans: accessPlans = [],
    runs = [],
    snapshots = [],
  } = state ?? {};

  try {
    assertPipelineContract("EvidencePipelineManifest", manifest, "pipeline manifest");
  } catch (error) {
    addIssue(issues, "MANIFEST_INVALID", "manifest", error.message);
  }
  validateRecords(issues, "SourceRegistryEntry", registry, "source_id");
  validateRecords(issues, "SourceAccessPlan", accessPlans, "plan_id");
  validateRecords(issues, "CollectionRun", runs, "run_id");
  validateRecords(issues, "RawSnapshot", snapshots, "snapshot_id");

  const sourceById = new Map((evidenceStore?.sources ?? []).map((source) => [source.source_id, source]));
  const registryById = new Map(registry.map((entry) => [entry.source_id, entry]));
  const planById = new Map(accessPlans.map((plan) => [plan.plan_id, plan]));
  const runById = new Map(runs.map((run) => [run.run_id, run]));
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.snapshot_id, snapshot]));

  if (manifest) {
    for (const [field, actual] of [
      ["source_count", registry.length],
      ["access_plan_count", accessPlans.length],
      ["run_count", runs.length],
      ["snapshot_count", snapshots.length],
    ]) {
      if (manifest[field] !== actual) addIssue(issues, "MANIFEST_COUNT_MISMATCH", "manifest", `${field}:${actual}`);
    }
    const networkUsed = runs.some((run) => run.external_network_used);
    if (manifest.external_collection_enabled !== networkUsed) {
      addIssue(issues, "EXTERNAL_COLLECTION_FLAG_MISMATCH", "manifest", networkUsed);
    }
  }

  for (const plan of accessPlans) {
    const policy = validateSourceAccessPlan(plan);
    for (const policyIssue of policy.issues) {
      addIssue(issues, `ACCESS_PLAN_${policyIssue.code}`, plan.plan_id, policyIssue.field);
    }
  }

  for (const entry of registry) {
    const source = sourceById.get(entry.source_id);
    if (!source) {
      addIssue(issues, "SOURCE_RECORD_MISSING", entry.source_id, "Evidence SourceRecord is required");
      continue;
    }
    if (source.source_type !== entry.source_type) {
      addIssue(issues, "SOURCE_TYPE_MISMATCH", entry.source_id, `${source.source_type}:${entry.source_type}`);
    }
    if (source.usage_restrictions !== entry.usage_restrictions) {
      addIssue(issues, "USAGE_RESTRICTION_MISMATCH", entry.source_id, entry.usage_restrictions);
    }
    if (sourceHost(source.url) !== entry.canonical_host) {
      addIssue(issues, "SOURCE_HOST_MISMATCH", entry.source_id, entry.canonical_host);
    }
    const plan = planById.get(entry.access_plan_id);
    if (!plan) {
      addIssue(issues, "ACCESS_PLAN_MISSING", entry.source_id, entry.access_plan_id);
    } else if (plan.source_type !== entry.source_type) {
      addIssue(issues, "ACCESS_PLAN_SOURCE_TYPE_MISMATCH", entry.source_id, entry.access_plan_id);
    }
    if (["blocked_automation", "retired"].includes(entry.collection_status) && plan?.enabled) {
      addIssue(issues, "DISABLED_SOURCE_PLAN_ENABLED", entry.source_id, entry.collection_status);
    }
  }

  for (const run of runs) {
    const entry = registryById.get(run.source_id);
    const plan = planById.get(run.access_plan_id);
    if (!entry) addIssue(issues, "RUN_SOURCE_MISSING", run.run_id, run.source_id);
    if (!plan) addIssue(issues, "RUN_PLAN_MISSING", run.run_id, run.access_plan_id);
    if (entry?.access_plan_id !== run.access_plan_id) {
      addIssue(issues, "RUN_PLAN_SOURCE_MISMATCH", run.run_id, run.access_plan_id);
    }
    if (plan?.adapter_id !== run.adapter_id) {
      addIssue(issues, "RUN_ADAPTER_MISMATCH", run.run_id, run.adapter_id);
    }
    const automated = AUTOMATED_ACCESS_MODES.has(plan?.access_mode);
    if (automated !== run.external_network_used) {
      addIssue(issues, "RUN_NETWORK_MODE_MISMATCH", run.run_id, plan?.access_mode);
    }
    for (const snapshotId of run.snapshot_ids) {
      const snapshot = snapshotById.get(snapshotId);
      if (!snapshot) addIssue(issues, "RUN_SNAPSHOT_MISSING", run.run_id, snapshotId);
      else if (snapshot.run_id !== run.run_id) addIssue(issues, "RUN_SNAPSHOT_MISMATCH", run.run_id, snapshotId);
    }
    if (["failed", "blocked", "partial"].includes(run.status) && !run.error_code) {
      addIssue(issues, "RUN_ERROR_CODE_REQUIRED", run.run_id, run.status);
    }
    if (!["failed", "blocked", "partial"].includes(run.status) && run.error_code) {
      addIssue(issues, "RUN_ERROR_CODE_UNEXPECTED", run.run_id, run.error_code);
    }
  }

  for (const snapshot of snapshots) {
    const run = runById.get(snapshot.run_id);
    const entry = registryById.get(snapshot.source_id);
    if (!run) addIssue(issues, "SNAPSHOT_RUN_MISSING", snapshot.snapshot_id, snapshot.run_id);
    if (!entry) addIssue(issues, "SNAPSHOT_SOURCE_MISSING", snapshot.snapshot_id, snapshot.source_id);
    if (run && (run.source_id !== snapshot.source_id || run.access_plan_id !== snapshot.access_plan_id)) {
      addIssue(issues, "SNAPSHOT_SCOPE_MISMATCH", snapshot.snapshot_id, snapshot.run_id);
    }
    if (snapshot.status === "captured") {
      if (!snapshot.content_sha256 || !snapshot.payload_ref || snapshot.storage_mode === "none") {
        addIssue(issues, "CAPTURED_PAYLOAD_REQUIRED", snapshot.snapshot_id, snapshot.storage_mode);
      }
      if (snapshot.error_code) addIssue(issues, "CAPTURED_ERROR_UNEXPECTED", snapshot.snapshot_id, snapshot.error_code);
    } else if (["failed", "blocked"].includes(snapshot.status)) {
      if (!snapshot.error_code) addIssue(issues, "SNAPSHOT_ERROR_CODE_REQUIRED", snapshot.snapshot_id, snapshot.status);
      if (snapshot.payload_ref || snapshot.content_sha256 || snapshot.storage_mode !== "none") {
        addIssue(issues, "FAILED_SNAPSHOT_PAYLOAD_FORBIDDEN", snapshot.snapshot_id, snapshot.storage_mode);
      }
    } else if (snapshot.status === "not_modified") {
      if (snapshot.error_code || snapshot.payload_ref || snapshot.storage_mode !== "none") {
        addIssue(issues, "NOT_MODIFIED_PAYLOAD_INVALID", snapshot.snapshot_id, snapshot.storage_mode);
      }
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    metrics: {
      source_count: registry.length,
      access_plan_count: accessPlans.length,
      run_count: runs.length,
      snapshot_count: snapshots.length,
      external_run_count: runs.filter((run) => run.external_network_used).length,
      unregistered_source_count: registry.filter((entry) => !sourceById.has(entry.source_id)).length,
    },
  };
}

export function assertEvidencePipelineState(state, evidenceStore) {
  const result = validateEvidencePipelineState(state, evidenceStore);
  if (!result.valid) {
    throw new Error(result.issues.map((item) => `${item.code}:${item.record_id}:${item.detail}`).join("; "));
  }
  return result;
}
