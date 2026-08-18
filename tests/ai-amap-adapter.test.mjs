import assert from "node:assert/strict";
import test from "node:test";

import {
  AMAP_KEY_ENV,
  AMAP_NETWORK_FLAG_ENV,
  AmapAdapterError,
  createAmapAccessPlan,
  createAmapCollectionBundle,
  fetchAmapPlaceDetail,
  materializeAmapCandidates,
  registeredAmapTargets,
} from "../src/ai-native/evidence/amapAdapter.js";
import { buildEvidencePipelineBaseline } from "../src/ai-native/evidence/pipelineRegistry.js";
import { validateCandidatePipeline } from "../src/ai-native/evidence/validateCandidatePipeline.js";
import { validateEvidencePipelineState } from "../src/ai-native/evidence/validatePipelineState.js";
import { loadEvidenceStore } from "./phase3b-fixtures.mjs";

const evidenceStore = await loadEvidenceStore();
const syntheticKey = "synthetic-amap-key-never-send";

function approvedPlan() {
  return createAmapAccessPlan({
    enabled: true,
    approvalStatus: "approved",
    termsReviewedAt: "2026-08-19",
    requestsPerMinute: 10,
    maxConcurrency: 1,
  });
}

function runtimeEnv() {
  return {
    [AMAP_NETWORK_FLAG_ENV]: "true",
    [AMAP_KEY_ENV]: syntheticKey,
  };
}

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function successPayload(target, overrides = {}) {
  return {
    status: "1",
    info: "OK",
    infocode: "10000",
    count: "1",
    pois: [{
      id: target.amap_poi_id,
      name: "本地合成门店",
      address: "本地合成地址",
      location: "121.477040,31.204990",
      business: { rating: "5.0", cost: "1", tel: "00000000" },
      photos: [{ title: "不得进入候选", url: "https://example.invalid/photo.jpg" }],
      ...overrides,
    }],
  };
}

function activateTargetPipeline(target, plan, bundle) {
  const pipeline = buildEvidencePipelineBaseline(evidenceStore);
  pipeline.access_plans.push(plan);
  const registry = pipeline.registry.find((entry) => entry.source_id === target.source_id);
  registry.access_plan_id = plan.plan_id;
  registry.collection_status = "approved_api";
  pipeline.runs.push(bundle.run);
  pipeline.snapshots.push(bundle.snapshot);
  pipeline.manifest.access_plan_count = pipeline.access_plans.length;
  pipeline.manifest.run_count = pipeline.runs.length;
  pipeline.manifest.snapshot_count = pipeline.snapshots.length;
  pipeline.manifest.external_collection_enabled = true;
  return pipeline;
}

test("discovers only explicitly registered Amap POI targets", () => {
  const targets = registeredAmapTargets(evidenceStore);
  assert.equal(targets.length, 6);
  assert.ok(targets.every((target) => target.source_id.startsWith("src-")));
  assert.ok(targets.every((target) => target.place_id.startsWith("hp-")));
  assert.ok(targets.every((target) => /^[A-Z0-9]+$/.test(target.amap_poi_id)));
});

test("keeps network access blocked until flag, key, approved plan, and client are all present", async () => {
  const target = registeredAmapTargets(evidenceStore)[0];
  let calls = 0;
  await assert.rejects(
    fetchAmapPlaceDetail({
      target,
      env: {},
      accessPlan: createAmapAccessPlan(),
      fetchImpl: async () => {
        calls += 1;
        return response(successPayload(target));
      },
    }),
    (error) => error instanceof AmapAdapterError
      && error.code === "AMAP_RUNTIME_BLOCKED"
      && !JSON.stringify(error).includes(syntheticKey),
  );
  assert.equal(calls, 0);
});

test("does not allow a reviewed but disabled plan to make a request", async () => {
  const target = registeredAmapTargets(evidenceStore)[0];
  let calls = 0;
  const disabledPlan = createAmapAccessPlan({
    enabled: false,
    approvalStatus: "approved",
    termsReviewedAt: "2026-08-19",
    requestsPerMinute: 10,
    maxConcurrency: 1,
  });
  await assert.rejects(
    fetchAmapPlaceDetail({
      target,
      env: runtimeEnv(),
      accessPlan: disabledPlan,
      fetchImpl: async () => {
        calls += 1;
        return response(successPayload(target));
      },
    }),
    (error) => error.code === "AMAP_RUNTIME_BLOCKED"
      && error.details.issues.includes("ACCESS_PLAN_DISABLED"),
  );
  assert.equal(calls, 0);
});

test("calls only the fixed POI detail endpoint and returns a field-minimized record", async () => {
  const target = registeredAmapTargets(evidenceStore)[0];
  let capturedUrl;
  const normalized = await fetchAmapPlaceDetail({
    target,
    env: runtimeEnv(),
    accessPlan: approvedPlan(),
    fetchImpl: async (url) => {
      capturedUrl = url;
      return response(successPayload(target));
    },
  });
  assert.equal(capturedUrl.origin, "https://restapi.amap.com");
  assert.equal(capturedUrl.pathname, "/v5/place/detail");
  assert.equal(capturedUrl.searchParams.get("id"), target.amap_poi_id);
  assert.equal(capturedUrl.searchParams.get("key"), syntheticKey);
  assert.deepEqual(Object.keys(normalized).sort(), [
    "address", "amap_poi_id", "location", "name", "place_id", "source_id",
  ]);
  assert.equal(JSON.stringify(normalized).includes(syntheticKey), false);
  assert.equal(JSON.stringify(normalized).includes("rating"), false);
  assert.equal(JSON.stringify(normalized).includes("photos"), false);
  assert.deepEqual(normalized.location, {
    coordinate_system: "GCJ-02",
    latitude: 31.20499,
    longitude: 121.47704,
  });
});

test("does not echo provider text or a secret when the provider rejects a request", async () => {
  const target = registeredAmapTargets(evidenceStore)[0];
  await assert.rejects(
    fetchAmapPlaceDetail({
      target,
      env: runtimeEnv(),
      accessPlan: approvedPlan(),
      fetchImpl: async () => response({
        status: "0",
        infocode: "10001",
        info: `INVALID_USER_KEY key=${syntheticKey}`,
      }),
    }),
    (error) => error.code === "AMAP_PROVIDER_REJECTED"
      && error.details.infocode === "10001"
      && !JSON.stringify(error).includes(syntheticKey)
      && !JSON.stringify(error).includes("INVALID_USER_KEY"),
  );
});

test("blocks an unexpected or missing POI instead of accepting an identity mismatch", async () => {
  const target = registeredAmapTargets(evidenceStore)[0];
  await assert.rejects(
    fetchAmapPlaceDetail({
      target,
      env: runtimeEnv(),
      accessPlan: approvedPlan(),
      fetchImpl: async () => response(successPayload(target, { id: "B0UNEXPECTED" })),
    }),
    (error) => error.code === "AMAP_IDENTITY_MISMATCH",
  );
});

test("turns a synthetic response into source-bound snapshots and pending candidates only", async () => {
  const target = registeredAmapTargets(evidenceStore)[0];
  const plan = approvedPlan();
  const normalized = await fetchAmapPlaceDetail({
    target,
    env: runtimeEnv(),
    accessPlan: plan,
    fetchImpl: async () => response(successPayload(target)),
  });
  const bundle = createAmapCollectionBundle({
    normalizedPlace: normalized,
    target,
    accessPlan: plan,
    capturedAt: "2026-08-19T10:00:00+08:00",
  });
  const pipeline = activateTargetPipeline(target, plan, bundle);
  const pipelineValidation = validateEvidencePipelineState(pipeline, evidenceStore);
  assert.equal(pipelineValidation.valid, true, JSON.stringify(pipelineValidation.issues));

  const candidates = materializeAmapCandidates(bundle, pipeline, evidenceStore);
  const candidateState = {
    candidates,
    deduplication_clusters: [],
    conflict_queue: [],
  };
  const candidateValidation = validateCandidatePipeline(candidateState, pipeline, evidenceStore);
  assert.equal(candidateValidation.valid, true, JSON.stringify(candidateValidation.issues));
  assert.deepEqual(candidates.map((candidate) => candidate.attribute), ["identity", "address", "coordinates"]);
  assert.ok(candidates.every((candidate) => candidate.status === "candidate"));
  assert.ok(candidates.every((candidate) => candidate.review_status === "pending"));
  assert.ok(candidates.every((candidate) => candidate.ai_is_factual_source === false));
  assert.ok(candidates.every((candidate) => candidate.place_match.requires_human_review === true));
  assert.equal(candidateValidation.metrics.published_candidate_count, 0);
  assert.equal(candidateValidation.metrics.ai_factual_source_count, 0);
  assert.equal(bundle.snapshot.source_url.includes(syntheticKey), false);
});
