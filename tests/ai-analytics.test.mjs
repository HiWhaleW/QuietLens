import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_DEFINITIONS,
  validateAnalyticsEvent,
} from "../src/ai-native/analytics/eventContract.js";
import { routeAnalyticsRequest } from "../worker/routes/analytics.js";

const numericProperties = new Set([
  "candidate_count", "unknown_count", "assumption_count", "field_count", "evidence_count",
  "claim_count", "place_scope_count", "source_type_count", "candidate_count_before",
  "candidate_count_after", "changed_field_count", "duration_ms", "hit_count", "citation_count",
  "total_duration_ms", "hard_constraint_count", "candidate_observation_count",
  "model_call_count", "reported_usage_call_count", "invalid_usage_call_count", "retry_count",
  "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens",
  "saved_preference_count", "saved_decision_count", "resulting_account_version", "account_version",
  "deleted_preference_count", "deleted_decision_count",
]);
const booleanProperties = new Set(["conservative_assumption_used", "request_preserved", "usage_complete"]);
const arrayProperties = new Set([
  "role_order", "unknown_types", "changed_fields", "relaxable_fields",
]);

function propertyValue(name) {
  if (["invalid_usage_call_count", "retry_count", "cached_input_tokens", "reasoning_output_tokens"].includes(name)) return 0;
  if (name === "total_tokens") return 2;
  if (numericProperties.has(name)) return 1;
  if (booleanProperties.has(name)) return true;
  if (arrayProperties.has(name)) return ["controlled_enum"];
  if (name === "place_id") return "hp-naive";
  if (name === "cost_schema_version") return "1.0.0";
  if (name === "operation") return "intent_initial";
  if (name === "model_version") return "deepseek-v4-flash";
  if (name === "prompt_version") return "intent-v0.4.1";
  if (name.endsWith("error_code")) return "VALIDATION_BLOCKED";
  return "controlled_enum";
}

function makeEvent(eventName) {
  const properties = Object.fromEntries(
    (EVENT_DEFINITIONS[eventName] ?? []).map((name) => [name, propertyValue(name)]),
  );
  return {
    event_name: eventName,
    event_schema_version: "1.0.0",
    session_id: "sess-test-001",
    request_id: "req-test-001",
    experience_stage: "F4",
    model_version: "not_applicable",
    prompt_version: "not_applicable",
    contract_schema_version: "1.0.0",
    evidence_store_version: "0.1.0",
    client_at: "2026-08-16T16:00:00+08:00",
    server_at: "2026-08-16T16:00:00+08:00",
    error_code: null,
    properties,
  };
}

test("accepts every versioned F0-F8 event with complete required properties", () => {
  for (const eventName of Object.keys(EVENT_DEFINITIONS)) {
    const result = validateAnalyticsEvent(makeEvent(eventName));
    assert.deepEqual(result.issues, [], `${eventName} should satisfy the event contract`);
  }
});

test("keeps server decision lifecycle events explicit in the versioned contract", () => {
  assert.deepEqual(EVENT_DEFINITIONS.retrieval_failed, ["duration_ms"]);
  assert.deepEqual(EVENT_DEFINITIONS.decision_reasoning_failed, ["duration_ms"]);
  assert.deepEqual(EVENT_DEFINITIONS.decision_published, [
    "candidate_count",
    "unknown_count",
    "total_duration_ms",
  ]);
  assert.deepEqual(EVENT_DEFINITIONS.exploration_marker_viewed, ["place_id", "score_bucket", "eligibility"]);
  assert.deepEqual(EVENT_DEFINITIONS.exploration_place_selected, ["place_id", "score_bucket", "eligibility", "source"]);
  assert.deepEqual(EVENT_DEFINITIONS.map_board_changed, ["from_region", "to_region", "source"]);
  assert.deepEqual(EVENT_DEFINITIONS.store_profile_viewed, ["place_id", "recommendation_status", "profile_version"]);
});

test("rejects missing event-specific properties", () => {
  const event = makeEvent("candidate_selected");
  delete event.properties.place_id;
  const result = validateAnalyticsEvent(event);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "EVENT_PROPERTY_MISSING"));
});

test("rejects raw language and sensitive local data", () => {
  const rawTextEvent = makeEvent("correction_submitted");
  rawTextEvent.properties.raw_text = "把插座改成最重要";
  const localPathEvent = makeEvent("retrieval_failed");
  localPathEvent.properties.debug_value = "/Users/example/private.txt";

  assert.ok(validateAnalyticsEvent(rawTextEvent).issues.some(
    (issue) => issue.code === "EVENT_PRIVACY_VIOLATION",
  ));
  assert.ok(validateAnalyticsEvent(localPathEvent).issues.some(
    (issue) => issue.code === "EVENT_PRIVACY_VIOLATION",
  ));
});

test("rejects incomplete or internally inconsistent model usage observations", () => {
  const event = makeEvent("model_usage_observed");
  event.properties.model_call_count = 2;
  event.properties.reported_usage_call_count = 1;
  event.properties.usage_complete = true;
  const result = validateAnalyticsEvent(event);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "EVENT_COST_OBSERVATION_INVALID"));
});

test("rejects unversioned or unknown events", () => {
  const event = makeEvent("candidate_selected");
  event.event_schema_version = "0.0.0";
  event.event_name = "mystery_event";
  const result = validateAnalyticsEvent(event);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "EVENT_SCHEMA_INVALID"));
  assert.ok(result.issues.some((issue) => issue.code === "EVENT_NAME_UNKNOWN"));
});

test("keeps model usage observations server-owned", async () => {
  let writeCount = 0;
  const event = makeEvent("model_usage_observed");
  const response = await routeAnalyticsRequest(new Request("https://quietlens.test/api/analytics", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://quietlens.test" },
    body: JSON.stringify(event),
  }), {
    QUIETLENS_ANALYTICS_SINK: { write: async () => { writeCount += 1; } },
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: { code: "ANALYTICS_EVENT_SERVER_ONLY" } });
  assert.equal(writeCount, 0);
});
