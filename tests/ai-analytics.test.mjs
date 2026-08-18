import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_DEFINITIONS,
  validateAnalyticsEvent,
} from "../src/ai-native/analytics/eventContract.js";

const numericProperties = new Set([
  "candidate_count", "unknown_count", "assumption_count", "field_count", "evidence_count",
  "claim_count", "place_scope_count", "source_type_count", "candidate_count_before",
  "candidate_count_after", "changed_field_count", "duration_ms", "hit_count", "citation_count",
  "total_duration_ms", "hard_constraint_count", "candidate_observation_count",
]);
const booleanProperties = new Set(["conservative_assumption_used", "request_preserved"]);
const arrayProperties = new Set([
  "role_order", "unknown_types", "changed_fields", "relaxable_fields",
]);

function propertyValue(name) {
  if (numericProperties.has(name)) return 1;
  if (booleanProperties.has(name)) return true;
  if (arrayProperties.has(name)) return ["controlled_enum"];
  if (name === "place_id") return "hp-naive";
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

test("rejects unversioned or unknown events", () => {
  const event = makeEvent("candidate_selected");
  event.event_schema_version = "0.0.0";
  event.event_name = "mystery_event";
  const result = validateAnalyticsEvent(event);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "EVENT_SCHEMA_INVALID"));
  assert.ok(result.issues.some((issue) => issue.code === "EVENT_NAME_UNKNOWN"));
});
