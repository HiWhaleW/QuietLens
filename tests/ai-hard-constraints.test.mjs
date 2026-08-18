import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateHardConstraint,
  filterPlacesByHardConstraints,
} from "../src/ai-native/evidence/hardConstraintFilter.js";
import { loadEvidenceStore, makeDecisionRequest } from "./phase3b-fixtures.mjs";

test("returns pass only when registered evidence supports a hard constraint", async () => {
  const { evidence } = await loadEvidenceStore();
  const result = evaluateHardConstraint("hp-cafe-on-air", {
    constraint_id: "hc-outlets",
    field: "outlets",
    operator: "available",
    value: true,
  }, evidence);

  assert.equal(result.status, "pass");
  assert.deepEqual(result.evidence_ids, ["ev-cafe-air-outlets"]);
});

test("compares structured coordinate values by content", async () => {
  const { evidence } = await loadEvidenceStore();
  const result = evaluateHardConstraint("hp-naive", {
    constraint_id: "hc-coordinates",
    field: "coordinates",
    operator: "equals",
    value: [31.243456, 121.484416],
  }, evidence);

  assert.equal(result.status, "pass");
});

test("returns fail for explicit contrary evidence", async () => {
  const { evidence } = await loadEvidenceStore();
  const result = evaluateHardConstraint("hp-east-sea", {
    constraint_id: "hc-noise",
    field: "noise",
    operator: "equals",
    value: "quiet_working",
  }, evidence);

  assert.equal(result.status, "fail");
  assert.equal(result.reason_code, "evidence_refutes");
});

test("returns unknown for missing or conflicted evidence", async () => {
  const { evidence } = await loadEvidenceStore();
  const missing = evaluateHardConstraint("hp-one-tenth", {
    constraint_id: "hc-outlets",
    field: "outlets",
    operator: "available",
    value: true,
  }, evidence);
  const conflicted = evaluateHardConstraint("hp-shiteng", {
    constraint_id: "hc-address",
    field: "address",
    operator: "equals",
    value: "威海路20-2号",
  }, evidence);

  assert.equal(missing.status, "unknown");
  assert.equal(missing.reason_code, "evidence_missing");
  assert.equal(conflicted.status, "unknown");
  assert.equal(conflicted.reason_code, "evidence_conflicted");
});

test("does not treat a non-constraint-grade observation as explicit failure", async () => {
  const { evidence } = await loadEvidenceStore();
  const result = evaluateHardConstraint("hp-blue-house", {
    constraint_id: "hc-daylight",
    field: "daylight",
    operator: "equals",
    value: "strong",
  }, evidence);

  assert.equal(result.status, "unknown");
  assert.equal(result.reason_code, "evidence_not_constraint_grade");
});

test("never promotes unknown hard constraints into eligible candidates", async () => {
  const store = await loadEvidenceStore();
  const request = makeDecisionRequest({
    hard_constraints: [{
      constraint_id: "hc-outlets",
      field: "outlets",
      operator: "available",
      value: true,
    }],
  });
  const requestBefore = structuredClone(request);
  const result = filterPlacesByHardConstraints(request, store.places, store.evidence);

  assert.deepEqual(request, requestBefore, "the filter must not relax or mutate the request");
  assert.deepEqual(result.eligible.map((entry) => entry.place_id), ["hp-cafe-on-air"]);
  assert.equal(result.uncertain.length, 9);
  assert.equal(result.rejected.length, 0);
});

test("keeps all verified allowlist places eligible when no hard constraint exists", async () => {
  const store = await loadEvidenceStore();
  const result = filterPlacesByHardConstraints(makeDecisionRequest(), store.places, store.evidence);

  assert.equal(result.eligible.length, 10);
  assert.equal(result.uncertain.length, 0);
  assert.equal(result.rejected.length, 0);
});
