import assert from "node:assert/strict";
import test from "node:test";

import { renderDeterministicSingleCandidate } from "../src/ai-native/decision/verifyAndRender.js";
import { retrieveEvidence } from "../src/ai-native/evidence/retrieveEvidence.js";
import { recommendForDecisionRequest } from "../worker/services/decisionService.js";

const V = "1.0.0";

// A synthetic controlled set. The published evidence snapshot is not part of
// this repository, so these cases build the smallest store that satisfies
// validateEvidenceStore and exercises the single-eligible-candidate path.
function source(placeId) {
  return {
    schema_version: V,
    source_id: `src-${placeId.slice(3)}`,
    source_type: "map_listing",
    publisher: "Fixture Publisher",
    author: null,
    title: "Fixture listing",
    url: "https://example.com/listing",
    published_at: "2026-01-01",
    accessed_at: "2026-01-01",
    reliability: "high",
    usage_restrictions: "public_reference",
    supports_place_ids: [placeId],
  };
}

function evidence(evidenceId, placeId, attribute, overrides = {}) {
  return {
    schema_version: V,
    evidence_id: evidenceId,
    place_id: placeId,
    attribute,
    claim_text: "fixture claim",
    normalized_value: true,
    constraint_usable: true,
    epistemic_status: "verified_fact",
    source_ids: [`src-${placeId.slice(3)}`],
    observed_at: "2026-01-01",
    published_at: "2026-01-01",
    verified_at: "2026-01-01",
    applicable_time: null,
    verification_status: "cross_checked",
    freshness: "current",
    reliability: "high",
    conflicts_with: [],
    conflict_status: "none",
    publishability: "factual",
    unknown_reason: null,
    ...overrides,
  };
}

function baseStore() {
  const places = [];
  const sources = [];
  const records = [];

  for (let index = 1; index <= 10; index += 1) {
    const placeId = `hp-p${index}`;
    sources.push(source(placeId));
    places.push({
      schema_version: V,
      place_id: placeId,
      canonical_name: `Fixture Cafe ${index}`,
      aliases: [],
      coverage_scope: "huangpu-10-v0.1",
      identity_status: "verified",
      address: { primary: "黄浦区示例路 1 号", variants: [], conflict_status: "none" },
      location: { coordinate_system: "WGS84", latitude: 31.23, longitude: 121.48, verified_at: "2026-01-01" },
      source_ids: [`src-p${index}`],
      known_unknowns: [{ attribute: "realtime_seats", reason: "no realtime feed" }],
      asset: { status: "pending", path: null },
    });
    for (const attribute of ["identity", "address", "coordinates"]) {
      records.push(evidence(`ev-${placeId}-${attribute}`, placeId, attribute, { normalized_value: "verified_storefront" }));
    }
    records.push(evidence(`ev-${placeId}-realtime`, placeId, "realtime_seats", {
      normalized_value: null,
      constraint_usable: false,
      epistemic_status: "unknown",
      source_ids: [],
      publishability: "not_factual",
      unknown_reason: "no realtime feed",
    }));
  }

  // Only hp-p1 can satisfy an "outlets available" hard constraint.
  records.push(evidence("ev-hp-p1-outlets", "hp-p1", "outlets", { normalized_value: true }));

  return {
    manifest: {
      database_version: "v0.1",
      evidence_store_version: "0.1.0",
      contract_schema_version: V,
      coverage_scope: "huangpu-10-v0.1",
      place_count: 10,
      ai_is_factual_source: false,
    },
    places,
    sources,
    evidence: records,
  };
}

// A documented conflict on an attribute that is retrieved for the task but is
// not itself a hard constraint. Retrieval favours these records: evidenceRank
// adds 25 points for any non-none conflict_status.
function withConflictedNoise(store) {
  store.evidence.push(evidence("ev-hp-p1-noise-a", "hp-p1", "noise", {
    normalized_value: "quiet_working",
    epistemic_status: "sourced_observation",
    conflicts_with: ["ev-hp-p1-noise-b"],
    conflict_status: "documented",
  }));
  store.evidence.push(evidence("ev-hp-p1-noise-b", "hp-p1", "noise", {
    normalized_value: "social_loud",
    epistemic_status: "sourced_observation",
    conflicts_with: ["ev-hp-p1-noise-a"],
    conflict_status: "documented",
  }));
  return store;
}

function singleCandidateRequest(requestId = "req-single-fixture") {
  return {
    schema_version: V,
    request_id: requestId,
    evidence_store_version: "0.1.0",
    task: { type: "focus", duration_minutes: 120 },
    time: { arrival_at: "2026-09-01T10:00", hard_leave_at: null, original_phrase: null },
    location: { area: "黄浦区", max_walk_minutes: 15 },
    hard_constraints: [{ constraint_id: "hc-single-outlets", field: "outlets", operator: "available", value: true }],
    soft_preferences: [],
    unknowns: [],
    assumptions: [],
    confirmed_by_user: false,
  };
}

function runtime(store, overrides = {}) {
  const events = [];
  return {
    events,
    env: {
      QUIETLENS_EVIDENCE_STORE: store,
      QUIETLENS_ANALYTICS_SINK: { write: async (event) => events.push(event) },
      QUIETLENS_MODEL_CLIENT: { callStructured: async () => { throw new Error("MODEL_MUST_NOT_RUN"); } },
      ...overrides,
    },
  };
}

test("renders the single confirmed option when its retrieved evidence carries a documented conflict", () => {
  const store = withConflictedNoise(baseStore());
  const request = singleCandidateRequest();
  const retrieval = retrieveEvidence(request, store);

  assert.equal(retrieval.candidates.filter((candidate) => candidate.eligibility === "eligible").length, 1);

  const result = renderDeterministicSingleCandidate({ request, retrieval, store });
  assert.equal(result.valid, true);
  assert.equal(result.brief.status, "published");
  assert.equal(result.brief.candidates.length, 1);

  const cited = result.brief.candidates[0].tradeoffs.flatMap((tradeoff) => tradeoff.evidence_ids);
  assert.deepEqual(cited.sort(), ["ev-hp-p1-noise-a", "ev-hp-p1-noise-b"]);
});

test("still renders a single confirmed option when nothing conflicts", () => {
  const store = baseStore();
  const request = singleCandidateRequest("req-single-clean");
  const retrieval = retrieveEvidence(request, store);

  const result = renderDeterministicSingleCandidate({ request, retrieval, store });
  assert.equal(result.valid, true);
  assert.equal(result.brief.candidates[0].tradeoffs.length, 0);
  assert.ok(result.brief.candidates[0].fit_reasons.length > 0);
});

test("publishes rather than failing the request when one candidate remains", async () => {
  const harness = runtime(withConflictedNoise(baseStore()));
  const result = await recommendForDecisionRequest(harness.env, {
    session_id: "sess-single-fixture",
    request: singleCandidateRequest("req-single-service"),
  });

  assert.equal(result.brief.status, "published");
  assert.equal(result.metrics.model_calls, 0);
  assert.ok(harness.events.some((event) => event.event_name === "decision_published"));
});

test("degrades to a deterministic refusal instead of throwing when the brief cannot be verified", async () => {
  // Constraint evidence is ranked but retrieval keeps only the top 8 records per
  // place, so supporting evidence can fall outside the retrieved set while the
  // constraint still passes against the full store. The renderer then cites an
  // unretrieved id. That must refuse, not escape as an unhandled error.
  const store = baseStore();
  const request = singleCandidateRequest("req-single-truncated");
  request.soft_preferences = [
    { field: "seating", priority: "high" },
    { field: "daylight", priority: "high" },
    { field: "workspace", priority: "high" },
  ];
  for (let index = 0; index < 9; index += 1) {
    store.evidence.push(evidence(`ev-hp-p1-a${index}`, "hp-p1", "seating", {
      normalized_value: "comfortable_work_seating",
      constraint_usable: false,
    }));
  }

  const retrieval = retrieveEvidence(request, store);
  const eligible = retrieval.candidates.filter((candidate) => candidate.eligibility === "eligible");
  assert.equal(eligible.length, 1);
  assert.equal(
    eligible[0].evidence.some((record) => record.evidence_id === "ev-hp-p1-outlets"),
    false,
    "fixture precondition: the constraint evidence must fall outside the retrieved window",
  );

  const originalError = console.error;
  console.error = () => {};
  try {
    const harness = runtime(store);
    const result = await recommendForDecisionRequest(harness.env, {
      session_id: "sess-single-truncated",
      request,
    });
    assert.equal(result.brief.status, "refused");
    assert.equal(result.brief.refusal.reason_code, "insufficient_comparable_candidates");
    assert.ok(harness.events.some((event) => event.event_name === "decision_refused"));
  } finally {
    console.error = originalError;
  }
});
