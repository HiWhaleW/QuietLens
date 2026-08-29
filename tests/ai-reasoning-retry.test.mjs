import assert from "node:assert/strict";
import test from "node:test";

import { recommendForDecisionRequest } from "../worker/services/decisionService.js";

const V = "1.0.0";

// The published evidence snapshot is not part of this repository, so these
// cases build the smallest store that satisfies validateEvidenceStore and
// leaves enough eligible candidates to reach the model-backed reasoning path.
function syntheticStore() {
  const places = [];
  const sources = [];
  const evidence = [];

  for (let index = 1; index <= 10; index += 1) {
    const placeId = `hp-p${index}`;
    sources.push({
      schema_version: V,
      source_id: `src-p${index}`,
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
    });
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
      evidence.push({
        schema_version: V,
        evidence_id: `ev-${placeId}-${attribute}`,
        place_id: placeId,
        attribute,
        claim_text: "fixture claim",
        normalized_value: "verified_storefront",
        constraint_usable: true,
        epistemic_status: "verified_fact",
        source_ids: [`src-p${index}`],
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
      });
    }
    evidence.push({
      schema_version: V,
      evidence_id: `ev-${placeId}-realtime`,
      place_id: placeId,
      attribute: "realtime_seats",
      claim_text: "no realtime feed",
      normalized_value: null,
      constraint_usable: false,
      epistemic_status: "unknown",
      source_ids: [],
      observed_at: null,
      published_at: null,
      verified_at: "2026-01-01",
      applicable_time: null,
      verification_status: "unverified",
      freshness: "unknown",
      reliability: "unknown",
      conflicts_with: [],
      conflict_status: "none",
      publishability: "not_factual",
      unknown_reason: "no realtime feed",
    });
  }

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
    evidence,
  };
}

function openRequest(requestId) {
  return {
    schema_version: V,
    request_id: requestId,
    evidence_store_version: "0.1.0",
    task: { type: "focus", duration_minutes: 120 },
    time: { arrival_at: "2026-09-01T10:00", hard_leave_at: null, original_phrase: null },
    location: { area: "黄浦区", max_walk_minutes: 15 },
    hard_constraints: [],
    soft_preferences: [],
    unknowns: [],
    assumptions: [],
    confirmed_by_user: false,
  };
}

function modelError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function attempt(env, requestId) {
  try {
    await recommendForDecisionRequest(env, { session_id: "sess-retry-fixture", request: openRequest(requestId) });
    return null;
  } catch (error) {
    return error;
  }
}

test("does not spend a second model call once the shared budget is gone", async () => {
  const timeoutMs = 300;
  const seen = [];
  const env = {
    QUIETLENS_EVIDENCE_STORE: syntheticStore(),
    QUIETLENS_ANALYTICS_SINK: { write: async () => {} },
    QL_REASONING_TIMEOUT_MS: String(timeoutMs),
    QUIETLENS_MODEL_CLIENT: {
      callStructured: async ({ timeoutMs: budget }) => {
        seen.push(budget);
        // Behaves like a call that burns its whole budget and then times out.
        await new Promise((resolve) => setTimeout(resolve, timeoutMs + 40));
        throw modelError("MODEL_TIMEOUT");
      },
    },
  };

  const error = await attempt(env, "req-retry-timeout");

  assert.equal(seen.length, 1, `expected the doomed retry to be skipped, model was called ${seen.length} times`);
  assert.equal(error.code, "MODEL_TIMEOUT");
  assert.ok(error.verification_repair_codes.includes("REASONING_RETRY_BUDGET_EXHAUSTED"));
  assert.equal(error.model_calls, 1);
});

test("still retries a transient failure that leaves usable budget", async () => {
  const seen = [];
  const env = {
    QUIETLENS_EVIDENCE_STORE: syntheticStore(),
    QUIETLENS_ANALYTICS_SINK: { write: async () => {} },
    QL_REASONING_TIMEOUT_MS: "5000",
    QUIETLENS_MODEL_CLIENT: {
      callStructured: async ({ timeoutMs: budget }) => {
        seen.push(budget);
        throw modelError("MODEL_OUTPUT_INVALID_JSON");
      },
    },
  };

  const error = await attempt(env, "req-retry-fast-failure");

  assert.equal(seen.length, 2, "a fast transient failure must still get its repair attempt");
  assert.equal(error.code, "MODEL_OUTPUT_INVALID_JSON");
  assert.equal(error.model_calls, 2);
});

test("gives the first attempt its full budget rather than the analytics-adjusted remainder", async () => {
  const seen = [];
  const env = {
    QUIETLENS_EVIDENCE_STORE: syntheticStore(),
    QL_REASONING_TIMEOUT_MS: "4000",
    // A slow sink used to be charged against the model's own time budget.
    QUIETLENS_ANALYTICS_SINK: { write: async () => { await new Promise((resolve) => setTimeout(resolve, 250)); } },
    QUIETLENS_MODEL_CLIENT: {
      callStructured: async ({ timeoutMs: budget }) => {
        seen.push(budget);
        throw modelError("MODEL_NETWORK_ERROR");
      },
    },
  };

  await attempt(env, "req-retry-budget-start");

  assert.ok(seen[0] > 3900, `first attempt should receive close to the configured budget, got ${seen[0]}ms`);
});
