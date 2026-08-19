import assert from "node:assert/strict";
import test from "node:test";

import { buildEvidencePipelineBaseline } from "../src/ai-native/evidence/pipelineRegistry.js";
import { validatePipelineContract } from "../src/ai-native/evidence/pipelineContracts.js";
import { validateEvidencePipelineState } from "../src/ai-native/evidence/validatePipelineState.js";
import { loadEvidenceStore } from "./phase3b-fixtures.mjs";

const evidenceStore = await loadEvidenceStore();

function capturedState() {
  const state = buildEvidencePipelineBaseline(evidenceStore);
  const source = evidenceStore.sources.find((item) => item.source_type === "signed_reporting");
  const entry = state.registry.find((item) => item.source_id === source.source_id);
  const plan = state.access_plans.find((item) => item.plan_id === entry.access_plan_id);
  const run = {
    schema_version: "1.0.0",
    run_id: "run-local-capture-v1",
    source_id: source.source_id,
    access_plan_id: plan.plan_id,
    adapter_id: plan.adapter_id,
    trigger: "manual",
    started_at: "2026-08-18T09:00:00+08:00",
    finished_at: "2026-08-18T09:01:00+08:00",
    status: "captured",
    request_count: 0,
    snapshot_ids: ["snap-local-capture-v1"],
    error_code: null,
    external_network_used: false,
  };
  const snapshot = {
    schema_version: "1.0.0",
    snapshot_id: "snap-local-capture-v1",
    run_id: run.run_id,
    source_id: source.source_id,
    access_plan_id: plan.plan_id,
    captured_at: "2026-08-18T09:01:00+08:00",
    status: "captured",
    source_url: source.url,
    http_status: null,
    content_type: "text/plain",
    content_length: 128,
    content_sha256: "a".repeat(64),
    payload_ref: "urn:quietlens:raw:local-capture-v1",
    storage_mode: "metadata_excerpt",
    personal_data_status: "none",
    ugc_full_text_stored: false,
    error_code: null,
    retry_after_at: null,
  };
  state.runs.push(run);
  state.snapshots.push(snapshot);
  state.manifest.run_count = 1;
  state.manifest.snapshot_count = 1;
  return state;
}

test("builds a versioned manual-only registry for all 32 Evidence v0.1 sources", () => {
  const state = buildEvidencePipelineBaseline(evidenceStore);
  const result = validateEvidencePipelineState(state, evidenceStore);
  const registeredSourceTypeCount = new Set(evidenceStore.sources.map((source) => source.source_type)).size;
  assert.equal(result.valid, true);
  assert.equal(result.metrics.source_count, 32);
  assert.equal(result.metrics.access_plan_count, registeredSourceTypeCount);
  assert.equal(result.metrics.run_count, 0);
  assert.equal(result.metrics.external_run_count, 0);
  assert.ok(state.registry.every((entry) => entry.collection_status === "manual_only"));
  assert.ok(state.access_plans.every((plan) => !["official_api", "licensed_api", "public_page"].includes(plan.access_mode)));
});

test("accepts a local metadata snapshot without network access or personal data", () => {
  const state = capturedState();
  assert.equal(validateEvidencePipelineState(state, evidenceStore).valid, true);
});

test("keeps raw payload content outside the snapshot metadata contract", () => {
  const snapshot = { ...capturedState().snapshots[0], raw_content: "third-party page body" };
  const result = validatePipelineContract("RawSnapshot", snapshot);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.keyword === "additionalProperties"));
});

test("rejects captured snapshots without an immutable hash and payload reference", () => {
  const state = capturedState();
  state.snapshots[0].content_sha256 = null;
  state.snapshots[0].payload_ref = null;
  const result = validateEvidencePipelineState(state, evidenceStore);
  assert.ok(result.issues.some((item) => item.code === "CAPTURED_PAYLOAD_REQUIRED"));
});

test("requires failures and access blocks to be explicit and payload-free", () => {
  const state = capturedState();
  Object.assign(state.snapshots[0], {
    status: "blocked",
    error_code: null,
  });
  Object.assign(state.runs[0], {
    status: "blocked",
    error_code: null,
  });
  const result = validateEvidencePipelineState(state, evidenceStore);
  const codes = new Set(result.issues.map((item) => item.code));
  assert.ok(codes.has("RUN_ERROR_CODE_REQUIRED"));
  assert.ok(codes.has("SNAPSHOT_ERROR_CODE_REQUIRED"));
  assert.ok(codes.has("FAILED_SNAPSHOT_PAYLOAD_FORBIDDEN"));
});

test("rejects missing SourceRecord, access-plan, run, and snapshot references", () => {
  const state = capturedState();
  state.registry[0].access_plan_id = "plan-missing-v1";
  state.snapshots[0].run_id = "run-missing-v1";
  const result = validateEvidencePipelineState(state, evidenceStore);
  const codes = new Set(result.issues.map((item) => item.code));
  assert.ok(codes.has("ACCESS_PLAN_MISSING"));
  assert.ok(codes.has("RUN_SNAPSHOT_MISMATCH"));
  assert.ok(codes.has("SNAPSHOT_RUN_MISSING"));
});

test("does not let an unapproved automated plan enter a valid pipeline state", () => {
  const state = buildEvidencePipelineBaseline(evidenceStore);
  const plan = state.access_plans.find((item) => item.source_type === "signed_reporting");
  Object.assign(plan, {
    host: "example.com",
    access_mode: "public_page",
    enabled: true,
    approval_status: "pending",
  });
  plan.rate_limit = { requests_per_minute: 6, max_concurrency: 1 };
  plan.controls = { ...plan.controls, honors_retry_after: true, uses_cache: true };
  const result = validateEvidencePipelineState(state, evidenceStore);
  assert.ok(result.issues.some((item) => item.code === "ACCESS_PLAN_APPROVAL_REQUIRED"));
});
