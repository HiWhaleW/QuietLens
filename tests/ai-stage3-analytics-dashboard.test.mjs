import assert from "node:assert/strict";
import test from "node:test";

import {
  analyticsRetentionMetadata,
  buildStage3AnalyticsDashboard,
  buildStage3AnalyticsDashboardFromExport,
  buildStage3AnalyticsDashboardFromExports,
  STAGE3_ANALYTICS_RETENTION_DAYS,
} from "../src/ai-native/analytics/stage3AnalyticsDashboard.js";
import { isLocalBetaAnalyticsDashboardLocation } from "../src/ai-native/evidence/reviewWorkbenchEntry.js";
import { emitAnalyticsEvent } from "../worker/analytics/telemetry.js";

const properties = {
  decision_request_submitted: { input_length_bucket: "short", entry_context: "homepage" },
  decision_brief_viewed: { candidate_count: 2, unknown_count: 1, assumption_count: 0 },
  decision_published: { candidate_count: 2, unknown_count: 1, total_duration_ms: 1200 },
  correction_submitted: { changed_field_count: 1 },
  place_detail_opened: { place_id: "hp-naive", source: "recommendation" },
  feedback_candidate_submitted: { place_id: "hp-naive", candidate_observation_count: 1 },
  model_usage_observed: {
    cost_schema_version: "1.0.0",
    operation: "intent_initial",
    model_version: "deepseek-v4-flash",
    prompt_version: "intent-v0.4.1",
    model_call_count: 1,
    reported_usage_call_count: 1,
    invalid_usage_call_count: 0,
    retry_count: 0,
    input_tokens: 10,
    cached_input_tokens: 0,
    output_tokens: 5,
    reasoning_output_tokens: 0,
    total_tokens: 15,
    usage_complete: true,
  },
};

function event(eventName, { session = "sess-one", request = "req-one", at = "2026-08-20T12:00:00.000Z" } = {}) {
  return {
    event_name: eventName,
    event_schema_version: "1.0.0",
    session_id: session,
    request_id: request,
    experience_stage: "F4",
    model_version: "not_applicable",
    prompt_version: "not_applicable",
    contract_schema_version: "1.0.0",
    evidence_store_version: "0.1.0",
    client_at: at,
    server_at: at,
    error_code: null,
    properties: properties[eventName],
  };
}

test("aggregates only privacy-safe events inside the fixed 30-day window", () => {
  const records = [
    event("decision_request_submitted"),
    event("decision_brief_viewed", { at: "2026-08-20T12:00:01.000Z" }),
    event("decision_published", { at: "2026-08-20T12:00:02.000Z" }),
    event("place_detail_opened", { at: "2026-08-20T12:00:03.000Z" }),
    event("correction_submitted", { session: "sess-two", request: "req-two", at: "2026-08-21T12:00:00.000Z" }),
    event("feedback_candidate_submitted", { session: "sess-two", request: "req-two", at: "2026-08-21T12:00:01.000Z" }),
    event("model_usage_observed", { at: "2026-08-20T12:00:04.000Z" }),
    event("decision_request_submitted", { session: "sess-old", request: "req-old", at: "2026-07-01T12:00:00.000Z" }),
    { event_name: "invalid" },
  ];
  const dashboard = buildStage3AnalyticsDashboard(records, { now: "2026-08-22T12:00:00.000Z" });

  assert.equal(dashboard.retention_days, 30);
  assert.equal(dashboard.metrics.event_count, 7);
  assert.equal(dashboard.metrics.active_session_count, 2);
  assert.equal(dashboard.metrics.decision_request_count, 1);
  assert.equal(dashboard.metrics.completion_count, 1);
  assert.equal(dashboard.metrics.model_call_count, 1);
  assert.equal(dashboard.metrics.total_tokens, 15);
  assert.equal(dashboard.funnel.completion_rate, 1);
  assert.equal(dashboard.daily.length, 2);
  assert.deepEqual(dashboard.ignored, {
    invalid_record_count: 1,
    outside_retention_count: 1,
    duplicate_record_count: 0,
  });
  assert.equal(JSON.stringify(dashboard).includes("sess-one"), false);
  assert.equal(JSON.stringify(dashboard).includes("req-one"), false);
});

test("reads structured JSON lines, counts parse errors, and removes duplicate log deliveries", () => {
  const first = event("decision_request_submitted");
  const text = [
    JSON.stringify({ type: "quietlens_analytics", event: first }),
    "not-json",
    JSON.stringify({ type: "quietlens_analytics", event: first }),
  ].join("\n");
  const dashboard = buildStage3AnalyticsDashboardFromExport(text, { now: "2026-08-22T12:00:00.000Z" });
  assert.equal(dashboard.metrics.event_count, 1);
  assert.equal(dashboard.parse_error_count, 1);
  assert.equal(dashboard.declared_dropped_event_count, 0);
  assert.equal(dashboard.ignored.duplicate_record_count, 1);
});

test("reads a veFaaS TLS record whose content field contains the analytics JSON", () => {
  const sample = event("decision_request_submitted");
  const text = JSON.stringify({
    function_id: "synthetic-function",
    log_type: "stdout",
    content: JSON.stringify({ type: "quietlens_analytics", event: sample }),
  });
  const dashboard = buildStage3AnalyticsDashboardFromExport(text, {
    now: "2026-08-22T12:00:00.000Z",
  });
  assert.equal(dashboard.metrics.event_count, 1);
  assert.equal(dashboard.metrics.decision_request_count, 1);
  assert.equal(dashboard.ignored.invalid_record_count, 0);
});

test("merges twenty server log exports without exposing identities and deduplicates repeat files", () => {
  const exports = Array.from({ length: 20 }, (_, index) => JSON.stringify({
    source: "server_log_export",
    retention_days: 30,
    dropped_event_count: index === 0 ? 2 : 0,
    events: [event("decision_request_submitted", {
      session: `sess-beta-${index}`,
      request: `req-beta-${index}`,
      at: `2026-08-20T12:${String(index).padStart(2, "0")}:00.000Z`,
    })],
  }));
  exports.push(exports[0]);

  const dashboard = buildStage3AnalyticsDashboardFromExports(exports, {
    now: "2026-08-22T12:00:00.000Z",
  });
  assert.equal(dashboard.source_export_count, 20);
  assert.equal(dashboard.duplicate_source_export_count, 1);
  assert.equal(dashboard.metrics.active_session_count, 20);
  assert.equal(dashboard.metrics.decision_request_count, 20);
  assert.equal(dashboard.ignored.duplicate_record_count, 0);
  assert.equal(dashboard.declared_dropped_event_count, 2);
  assert.equal(JSON.stringify(dashboard).includes("sess-beta"), false);
  assert.equal(JSON.stringify(dashboard).includes("req-beta"), false);
});

test("adds a 30-day expiry contract to analytics sink writes", async () => {
  const writes = [];
  const sample = event("decision_request_submitted");
  await emitAnalyticsEvent({
    QUIETLENS_ANALYTICS_SINK: { write: async (...args) => writes.push(args) },
  }, sample);
  assert.equal(STAGE3_ANALYTICS_RETENTION_DAYS, 30);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], sample);
  assert.deepEqual(writes[0][1], analyticsRetentionMetadata(sample.server_at));
  assert.equal(writes[0][1].expires_at, "2026-09-19T12:00:00.000Z");
});

test("keeps the Beta analytics dashboard localhost-only", () => {
  assert.equal(isLocalBetaAnalyticsDashboardLocation({ hostname: "localhost", search: "?workbench=beta-analytics" }), true);
  assert.equal(isLocalBetaAnalyticsDashboardLocation({ hostname: "127.0.0.1", search: "?workbench=beta-analytics" }), true);
  assert.equal(isLocalBetaAnalyticsDashboardLocation({ hostname: "quietlens.example", search: "?workbench=beta-analytics" }), false);
  assert.equal(isLocalBetaAnalyticsDashboardLocation({ hostname: "localhost", search: "?workbench=evidence-review" }), false);
});
