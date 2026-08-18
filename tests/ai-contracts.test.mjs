import assert from "node:assert/strict";
import test from "node:test";

import { assertContract } from "../src/ai-native/contracts/validator.js";
import { validateEvidenceStore } from "../src/ai-native/evidence/validateStore.js";
import { loadEvidenceStore, makeDecisionRequest } from "./phase3b-fixtures.mjs";

test("validates all v0.1 records and their cross-record references", async () => {
  const store = await loadEvidenceStore();
  const result = validateEvidenceStore(store);

  assert.deepEqual(result.issues, []);
  assert.equal(result.metrics.place_count, 10);
  assert.equal(result.metrics.unsupported_fact_rate, 0);
  assert.equal(result.metrics.citation_existence_rate, 1);
  assert.equal(store.manifest.place_count, store.places.length);
  assert.equal(store.manifest.source_count, store.sources.length);
  assert.equal(store.manifest.evidence_count, store.evidence.length);
});

test("forbids AI as a factual source type", async () => {
  const store = structuredClone(await loadEvidenceStore());
  store.sources[0].source_type = "ai_generated";
  const result = validateEvidenceStore(store);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "SCHEMA_INVALID"));
});

test("blocks a non-unknown claim without a source", async () => {
  const store = structuredClone(await loadEvidenceStore());
  const record = store.evidence.find((entry) => entry.epistemic_status === "verified_fact");
  record.source_ids = [];
  const result = validateEvidenceStore(store);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "UNSUPPORTED_FACT"));
});

test("blocks a citation that does not exist", async () => {
  const store = structuredClone(await loadEvidenceStore());
  const record = store.evidence.find((entry) => entry.epistemic_status === "verified_fact");
  record.source_ids = ["src-does-not-exist"];
  const result = validateEvidenceStore(store);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "CITATION_MISSING"));
});

test("validates the DecisionRequest contract independently of a model", () => {
  const request = makeDecisionRequest({
    hard_constraints: [{
      constraint_id: "hc-outlets",
      field: "outlets",
      operator: "available",
      value: true,
    }],
  });

  assert.equal(assertContract("DecisionRequest", request), request);
});
