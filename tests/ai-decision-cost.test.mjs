import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateDecisionCost,
  aggregateDecisionCostEvents,
  createModelUsageObservation,
  validateModelUsageObservation,
} from "../src/ai-native/analytics/decisionCost.js";
import {
  DEEPSEEK_PRICE_SOURCE,
  deepSeekPriceCatalogAt,
  deepSeekPriceCatalogForEvents,
  deepSeekRateWindowAt,
} from "../src/ai-native/analytics/deepseekPriceCatalog.js";
import { buildDecisionCostExport } from "../src/ai-native/analytics/decisionCostExport.js";
import {
  buildDecisionCostRetentionBatch,
  deepSeekPriceReviewStatus,
  eventsFromDecisionCostRetentionBatch,
  verifyDecisionCostRetentionBatch,
} from "../src/ai-native/analytics/decisionCostRetention.js";
import { validateAnalyticsEvent } from "../src/ai-native/analytics/eventContract.js";
import { analyticsEvent } from "../worker/analytics/telemetry.js";

function usage(input, output, { cached = 0, reasoning = 0 } = {}) {
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: { reasoning_tokens: reasoning },
    raw_text: "must-never-survive-normalization",
  };
}

test("normalizes model usage without retaining prompts, responses, or provider payloads", () => {
  const observation = createModelUsageObservation({
    operation: "intent_initial",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "intent-v0.4.1",
    modelCalls: 2,
    usage: [
      usage(100, 50, { cached: 20, reasoning: 10 }),
      usage(80, 20),
    ],
  });

  assert.deepEqual(observation, {
    cost_schema_version: "1.0.0",
    operation: "intent_initial",
    model_version: "deepseek-v4-flash",
    prompt_version: "intent-v0.4.1",
    model_call_count: 2,
    reported_usage_call_count: 2,
    invalid_usage_call_count: 0,
    retry_count: 1,
    input_tokens: 180,
    cached_input_tokens: 20,
    output_tokens: 70,
    reasoning_output_tokens: 10,
    total_tokens: 250,
    usage_complete: true,
  });
  assert.deepEqual(validateModelUsageObservation(observation), { valid: true, issues: [] });
  assert.equal(JSON.stringify(observation).includes("must-never-survive-normalization"), false);
  assert.equal(Object.hasOwn(observation, "raw_text"), false);
});

test("reconstructs calls, retries, tokens, and explicit versioned price cost", () => {
  const intent = createModelUsageObservation({
    operation: "intent_initial",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "intent-v0.4.1",
    modelCalls: 2,
    usage: [usage(100, 50, { cached: 20, reasoning: 10 }), usage(80, 20)],
  });
  const reasoning = createModelUsageObservation({
    operation: "decision_reasoning",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "reasoner-v0.4.1",
    modelCalls: 1,
    usage: [usage(200, 100, { cached: 50, reasoning: 30 })],
  });
  const report = aggregateDecisionCost({
    requestId: "req-cost-001",
    outcome: "published",
    observations: [intent, reasoning],
    priceCatalog: {
      catalog_version: "synthetic-v1",
      currency: "USD",
      models: {
        "deepseek-v4-flash": {
          input_microunits_per_million: 1_000_000,
          cached_input_microunits_per_million: 500_000,
          output_microunits_per_million: 2_000_000,
        },
      },
    },
  });

  assert.equal(report.model_call_count, 3);
  assert.equal(report.retry_count, 1);
  assert.equal(report.input_tokens, 380);
  assert.equal(report.cached_input_tokens, 70);
  assert.equal(report.output_tokens, 170);
  assert.equal(report.total_tokens, 550);
  assert.equal(report.usage_coverage_complete, true);
  assert.equal(report.cost_status, "calculated");
  assert.equal(report.currency, "USD");
  assert.equal(report.price_catalog_version, "synthetic-v1");
  assert.equal(report.estimated_cost_microunits, 685);
  assert.equal(report.rounding_policy, "ceil_to_microunit");
});

test("fails cost coverage closed when a retry has no valid provider usage", () => {
  const incomplete = createModelUsageObservation({
    operation: "decision_reasoning",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "reasoner-v0.4.1",
    modelCalls: 2,
    usage: [usage(100, 20)],
  });
  const report = aggregateDecisionCost({
    requestId: "req-cost-002",
    outcome: "failed",
    observations: [incomplete],
    priceCatalog: {
      catalog_version: "synthetic-v1",
      currency: "USD",
      models: {
        "deepseek-v4-flash": {
          input_microunits_per_million: 1,
          output_microunits_per_million: 1,
        },
      },
    },
  });

  assert.equal(incomplete.retry_count, 1);
  assert.equal(incomplete.usage_complete, false);
  assert.equal(report.usage_coverage_complete, false);
  assert.equal(report.cost_status, "usage_incomplete");
  assert.equal(report.estimated_cost_microunits, null);
});

test("never guesses a monetary cost without a matching price catalog", () => {
  const observation = createModelUsageObservation({
    operation: "intent_correction",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "intent-v0.4.1",
    modelCalls: 1,
    usage: [usage(10, 5)],
  });
  const missingCatalog = aggregateDecisionCost({
    requestId: "req-cost-003",
    outcome: "published",
    observations: [observation],
  });
  const missingModel = aggregateDecisionCost({
    requestId: "req-cost-003",
    outcome: "published",
    observations: [observation],
    priceCatalog: { catalog_version: "synthetic-v1", currency: "CNY", models: {} },
  });

  assert.equal(missingCatalog.cost_status, "price_catalog_missing");
  assert.equal(missingCatalog.estimated_cost_microunits, null);
  assert.equal(missingModel.cost_status, "model_price_missing");
  assert.equal(missingModel.estimated_cost_microunits, null);
});

test("records deterministic zero-call paths as zero cost without inventing a price", () => {
  const observation = createModelUsageObservation({
    operation: "decision_reasoning",
    modelVersion: "not-invoked",
    promptVersion: "deterministic-refusal-v0.1.0",
    modelCalls: 0,
    usage: [],
  });
  const report = aggregateDecisionCost({
    requestId: "req-cost-004",
    outcome: "refused",
    observations: [observation],
  });

  assert.equal(report.usage_coverage_complete, true);
  assert.equal(report.cost_status, "calculated");
  assert.equal(report.estimated_cost_microunits, 0);
  assert.equal(report.currency, null);
});

test("accepts the privacy-minimized observation in the versioned analytics contract", () => {
  const properties = createModelUsageObservation({
    operation: "intent_initial",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "intent-v0.4.1",
    modelCalls: 1,
    usage: [usage(10, 5)],
  });
  const event = analyticsEvent({
    eventName: "model_usage_observed",
    sessionId: "sess-cost-001",
    requestId: "req-cost-005",
    stage: "F1",
    modelVersion: properties.model_version,
    promptVersion: properties.prompt_version,
    clientAt: "2026-08-19T12:00:00+08:00",
    serverAt: "2026-08-19T12:00:01+08:00",
    properties,
  });

  assert.deepEqual(validateAnalyticsEvent(event).issues, []);
});

test("reconstructs a qualified decision directly from its server analytics events", () => {
  const intentProperties = createModelUsageObservation({
    operation: "intent_initial",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "intent-v0.4.1",
    modelCalls: 1,
    usage: [usage(10, 5)],
  });
  const reasonerProperties = createModelUsageObservation({
    operation: "decision_reasoning",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "reasoner-v0.4.1",
    modelCalls: 1,
    usage: [usage(20, 10)],
  });
  const events = [
    analyticsEvent({
      eventName: "model_usage_observed",
      sessionId: "sess-cost-stream",
      requestId: "req-cost-stream",
      stage: "F1",
      modelVersion: intentProperties.model_version,
      promptVersion: intentProperties.prompt_version,
      properties: intentProperties,
    }),
    analyticsEvent({
      eventName: "model_usage_observed",
      sessionId: "sess-cost-stream",
      requestId: "req-cost-stream",
      stage: "F4",
      modelVersion: reasonerProperties.model_version,
      promptVersion: reasonerProperties.prompt_version,
      properties: reasonerProperties,
    }),
    analyticsEvent({
      eventName: "decision_published",
      sessionId: "sess-cost-stream",
      requestId: "req-cost-stream",
      stage: "F4",
      modelVersion: "deepseek-v4-flash",
      promptVersion: "reasoner-v0.4.1",
      properties: { candidate_count: 2, unknown_count: 1, total_duration_ms: 100 },
    }),
  ];
  events.push({ ...events[0], request_id: "req-unrelated" });

  const report = aggregateDecisionCostEvents({ requestId: "req-cost-stream", events });

  assert.equal(report.outcome, "published");
  assert.equal(report.operation_count, 2);
  assert.equal(report.model_call_count, 2);
  assert.equal(report.total_tokens, 45);
  assert.equal(report.usage_coverage_complete, true);
  assert.equal(report.cost_status, "price_catalog_missing");
});

test("selects the official DeepSeek peak or off-peak catalog from UTC event time", () => {
  assert.equal(DEEPSEEK_PRICE_SOURCE.model, "deepseek-v4-flash");
  assert.equal(DEEPSEEK_PRICE_SOURCE.provider_model_version, "DeepSeek-V4-Flash-0731");
  assert.equal(deepSeekRateWindowAt("2026-08-19T00:59:59Z"), "off_peak");
  assert.equal(deepSeekRateWindowAt("2026-08-19T01:00:00Z"), "peak");
  assert.equal(deepSeekRateWindowAt("2026-08-19T04:00:00Z"), "off_peak");
  assert.equal(deepSeekRateWindowAt("2026-08-19T06:00:00Z"), "peak");
  assert.equal(deepSeekRateWindowAt("2026-08-19T10:00:00Z"), "off_peak");

  assert.deepEqual(deepSeekPriceCatalogAt("2026-08-19T05:00:00Z").models["deepseek-v4-flash"], {
    input_microunits_per_million: 220_000,
    cached_input_microunits_per_million: 7_000,
    output_microunits_per_million: 660_000,
  });
  assert.deepEqual(deepSeekPriceCatalogAt("2026-08-19T07:00:00Z").models["deepseek-v4-flash"], {
    input_microunits_per_million: 440_000,
    cached_input_microunits_per_million: 14_000,
    output_microunits_per_million: 1_320_000,
  });
});

test("calculates from the matching official window and blocks a mixed-window decision", () => {
  const properties = createModelUsageObservation({
    operation: "intent_initial",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "intent-v0.4.1",
    modelCalls: 1,
    usage: [usage(1_000_000, 1_000_000)],
  });
  const usageEvent = analyticsEvent({
    eventName: "model_usage_observed",
    sessionId: "sess-off-peak",
    requestId: "req-off-peak",
    stage: "F1",
    modelVersion: properties.model_version,
    promptVersion: properties.prompt_version,
    clientAt: "2026-08-19T05:00:00Z",
    serverAt: "2026-08-19T05:00:00Z",
    properties,
  });
  const terminalEvent = analyticsEvent({
    eventName: "decision_published",
    sessionId: "sess-off-peak",
    requestId: "req-off-peak",
    stage: "F4",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "reasoner-v0.4.1",
    clientAt: "2026-08-19T05:00:01Z",
    serverAt: "2026-08-19T05:00:01Z",
    properties: { candidate_count: 2, unknown_count: 0, total_duration_ms: 100 },
  });
  const events = [usageEvent, terminalEvent];
  const report = aggregateDecisionCostEvents({
    requestId: "req-off-peak",
    events,
    priceCatalog: deepSeekPriceCatalogForEvents(events),
  });

  assert.equal(report.price_catalog_version, "deepseek-v4-flash-2026-08-19-off-peak-v1");
  assert.equal(report.estimated_cost_microunits, 880_000);

  assert.throws(() => deepSeekPriceCatalogForEvents([
    usageEvent,
    { ...usageEvent, server_at: "2026-08-19T07:00:00Z" },
  ]), /DEEPSEEK_PRICE_WINDOW_MIXED/);
});

test("exports qualified-decision coverage without session ids or raw event payloads", () => {
  const completeProperties = createModelUsageObservation({
    operation: "intent_initial",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "intent-v0.4.1",
    modelCalls: 1,
    usage: [usage(100, 50)],
  });
  const completeUsageEvent = analyticsEvent({
    eventName: "model_usage_observed",
    sessionId: "sess-export-private",
    requestId: "req-export-complete",
    stage: "F1",
    modelVersion: completeProperties.model_version,
    promptVersion: completeProperties.prompt_version,
    clientAt: "2026-08-19T05:00:00Z",
    serverAt: "2026-08-19T05:00:00Z",
    properties: completeProperties,
  });
  const publishedEvent = analyticsEvent({
    eventName: "decision_published",
    sessionId: "sess-export-private",
    requestId: "req-export-complete",
    stage: "F4",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "reasoner-v0.4.1",
    clientAt: "2026-08-19T05:00:01Z",
    serverAt: "2026-08-19T05:00:01Z",
    properties: { candidate_count: 2, unknown_count: 0, total_duration_ms: 100 },
  });
  const missingObservationPublished = {
    ...publishedEvent,
    request_id: "req-export-missing",
    session_id: "sess-export-missing",
  };
  const exportReport = buildDecisionCostExport({
    events: [
      completeUsageEvent,
      publishedEvent,
      missingObservationPublished,
      { event_name: "client_noise", request_id: "req-export-complete", raw_text: "do not export" },
    ],
    generatedAt: "2026-08-19T12:00:00Z",
  });

  assert.equal(exportReport.export_schema_version, "1.0.0");
  assert.equal(exportReport.qualified_decision_count, 2);
  assert.equal(exportReport.qualified_usage_complete_count, 1);
  assert.equal(exportReport.qualified_cost_calculated_count, 1);
  assert.equal(exportReport.qualified_usage_coverage_rate, 0.5);
  assert.equal(exportReport.qualified_cost_coverage_rate, 0.5);
  assert.equal(exportReport.reports[0].cost_status, "calculated");
  assert.equal(exportReport.reports[1].cost_status, "observation_missing");
  const serialized = JSON.stringify(exportReport);
  assert.equal(serialized.includes("sess-export-private"), false);
  assert.equal(serialized.includes("do not export"), false);
});

test("builds a privacy-minimized deduplicated retention batch", async () => {
  const properties = createModelUsageObservation({
    operation: "intent_initial",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "intent-v0.4.1",
    modelCalls: 1,
    usage: [usage(100, 50)],
  });
  const usageEvent = analyticsEvent({
    eventName: "model_usage_observed",
    sessionId: "sess-retention-private",
    requestId: "req-retention-complete",
    stage: "F1",
    modelVersion: properties.model_version,
    promptVersion: properties.prompt_version,
    clientAt: "2026-08-19T05:00:00Z",
    serverAt: "2026-08-19T05:00:00Z",
    properties,
  });
  const terminalEvent = analyticsEvent({
    eventName: "decision_published",
    sessionId: "sess-retention-private",
    requestId: "req-retention-complete",
    stage: "F4",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "reasoner-v0.4.1",
    clientAt: "2026-08-19T05:00:01Z",
    serverAt: "2026-08-19T05:00:01Z",
    properties: { candidate_count: 2, unknown_count: 0, total_duration_ms: 100 },
  });
  const batch = await buildDecisionCostRetentionBatch({
    events: [
      usageEvent,
      usageEvent,
      terminalEvent,
      { event_name: "unrelated", session_id: "sess-private", raw_text: "must not persist" },
    ],
    windowStart: "2026-08-19T00:00:00Z",
    windowEnd: "2026-08-20T00:00:00Z",
    createdAt: "2026-08-20T00:01:00Z",
  });

  assert.equal(batch.relevant_event_count, 3);
  assert.equal(batch.retained_record_count, 2);
  assert.equal(batch.duplicate_event_count, 1);
  assert.equal(batch.ignored_event_count, 1);
  assert.equal(batch.delete_after, "2026-11-18T00:00:00.000Z");
  assert.deepEqual(await verifyDecisionCostRetentionBatch(batch), { valid: true, issue_code: null });
  const serialized = JSON.stringify(batch);
  assert.equal(serialized.includes("sess-retention-private"), false);
  assert.equal(serialized.includes("must not persist"), false);
  assert.equal(serialized.includes("candidate_count"), false);
});

test("reconstructs an export from a verified retention batch", async () => {
  const properties = createModelUsageObservation({
    operation: "decision_reasoning",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "reasoner-v0.4.1",
    modelCalls: 2,
    usage: [usage(100, 50), usage(20, 10)],
  });
  const events = [
    analyticsEvent({
      eventName: "model_usage_observed",
      sessionId: "sess-retained-export",
      requestId: "req-retained-export",
      stage: "F4",
      modelVersion: properties.model_version,
      promptVersion: properties.prompt_version,
      clientAt: "2026-08-19T05:00:00Z",
      serverAt: "2026-08-19T05:00:00Z",
      properties,
    }),
    analyticsEvent({
      eventName: "decision_published",
      sessionId: "sess-retained-export",
      requestId: "req-retained-export",
      stage: "F4",
      modelVersion: "deepseek-v4-flash",
      promptVersion: "reasoner-v0.4.1",
      clientAt: "2026-08-19T05:00:01Z",
      serverAt: "2026-08-19T05:00:01Z",
      properties: { candidate_count: 2, unknown_count: 0, total_duration_ms: 100 },
    }),
  ];
  const batch = await buildDecisionCostRetentionBatch({
    events,
    windowStart: "2026-08-19T00:00:00Z",
    windowEnd: "2026-08-20T00:00:00Z",
    createdAt: "2026-08-20T00:01:00Z",
  });
  const retainedEvents = await eventsFromDecisionCostRetentionBatch(batch);
  const exportReport = buildDecisionCostExport({
    events: retainedEvents,
    generatedAt: "2026-08-20T00:02:00Z",
  });
  assert.equal(exportReport.qualified_decision_count, 1);
  assert.equal(exportReport.qualified_usage_coverage_rate, 1);
  assert.equal(exportReport.qualified_cost_coverage_rate, 1);
  assert.equal(exportReport.reports[0].retry_count, 1);
});

test("detects any retained cost record or manifest tampering", async () => {
  const properties = createModelUsageObservation({
    operation: "intent_initial",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "intent-v0.4.1",
    modelCalls: 1,
    usage: [usage(10, 5)],
  });
  const batch = await buildDecisionCostRetentionBatch({
    events: [analyticsEvent({
      eventName: "model_usage_observed",
      sessionId: "sess-retention-tamper",
      requestId: "req-retention-tamper",
      stage: "F1",
      modelVersion: properties.model_version,
      promptVersion: properties.prompt_version,
      clientAt: "2026-08-19T05:00:00Z",
      serverAt: "2026-08-19T05:00:00Z",
      properties,
    })],
    windowStart: "2026-08-19T00:00:00Z",
    windowEnd: "2026-08-20T00:00:00Z",
    createdAt: "2026-08-20T00:01:00Z",
  });
  const tampered = JSON.parse(JSON.stringify(batch));
  tampered.records[0].properties.total_tokens += 1;
  assert.deepEqual(await verifyDecisionCostRetentionBatch(tampered), {
    valid: false,
    issue_code: "DECISION_COST_RETENTION_BATCH_CORRUPT",
  });
  await assert.rejects(() => eventsFromDecisionCostRetentionBatch(tampered), /DECISION_COST_RETENTION_BATCH_CORRUPT/);
});

test("includes failed and blocked terminal outcomes in cost exports", () => {
  const properties = createModelUsageObservation({
    operation: "decision_reasoning",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "reasoner-v0.4.1",
    modelCalls: 2,
    usage: [usage(100, 20), usage(100, 20)],
  });
  const usageEvent = analyticsEvent({
    eventName: "model_usage_observed",
    sessionId: "sess-failed-cost",
    requestId: "req-failed-cost",
    stage: "F4",
    modelVersion: properties.model_version,
    promptVersion: properties.prompt_version,
    clientAt: "2026-08-19T05:00:00Z",
    serverAt: "2026-08-19T05:00:00Z",
    properties,
  });
  const failedEvent = analyticsEvent({
    eventName: "decision_reasoning_failed",
    sessionId: "sess-failed-cost",
    requestId: "req-failed-cost",
    stage: "F4",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "reasoner-v0.4.1",
    clientAt: "2026-08-19T05:00:01Z",
    serverAt: "2026-08-19T05:00:01Z",
    properties: { duration_ms: 100 },
  });
  const blockedEvent = {
    ...failedEvent,
    event_name: "evidence_verification_blocked",
    request_id: "req-blocked-cost",
  };
  const exportReport = buildDecisionCostExport({
    events: [usageEvent, failedEvent, blockedEvent],
    generatedAt: "2026-08-19T06:00:00Z",
  });
  assert.equal(exportReport.terminal_decision_count, 2);
  assert.equal(exportReport.qualified_decision_count, 0);
  assert.equal(exportReport.reports.find((report) => report.request_id === "req-failed-cost").retry_count, 1);
  assert.equal(exportReport.reports.find((report) => report.request_id === "req-blocked-cost").cost_status, "observation_missing");
});

test("marks the official price catalog overdue after the free 30-day review interval", () => {
  assert.deepEqual(deepSeekPriceReviewStatus({ verifiedAt: "2026-08-19", asOf: "2026-09-17" }), {
    verified_at: "2026-08-19",
    as_of: "2026-09-17",
    review_interval_days: 30,
    next_review_due_at: "2026-09-18",
    status: "current",
    blocks_cost_calculation: false,
  });
  assert.equal(deepSeekPriceReviewStatus({ verifiedAt: "2026-08-19", asOf: "2026-09-18" }).status, "due");
  const overdue = deepSeekPriceReviewStatus({ verifiedAt: "2026-08-19", asOf: "2026-09-19" });
  assert.equal(overdue.status, "overdue");
  assert.equal(overdue.blocks_cost_calculation, true);
});

test("refuses to calculate nonzero model cost after the official price review is overdue", () => {
  const properties = createModelUsageObservation({
    operation: "intent_initial",
    modelVersion: "deepseek-v4-flash",
    promptVersion: "intent-v0.4.1",
    modelCalls: 1,
    usage: [usage(100, 50)],
  });
  const events = [
    analyticsEvent({
      eventName: "model_usage_observed",
      sessionId: "sess-overdue-price",
      requestId: "req-overdue-price",
      stage: "F1",
      modelVersion: properties.model_version,
      promptVersion: properties.prompt_version,
      clientAt: "2026-08-19T05:00:00Z",
      serverAt: "2026-08-19T05:00:00Z",
      properties,
    }),
    analyticsEvent({
      eventName: "decision_published",
      sessionId: "sess-overdue-price",
      requestId: "req-overdue-price",
      stage: "F4",
      modelVersion: "deepseek-v4-flash",
      promptVersion: "reasoner-v0.4.1",
      clientAt: "2026-08-19T05:00:01Z",
      serverAt: "2026-08-19T05:00:01Z",
      properties: { candidate_count: 2, unknown_count: 0, total_duration_ms: 100 },
    }),
  ];
  const exportReport = buildDecisionCostExport({
    events,
    generatedAt: "2026-09-19T00:00:00Z",
  });
  assert.equal(exportReport.price_review.status, "overdue");
  assert.equal(exportReport.qualified_cost_coverage_rate, 0);
  assert.equal(exportReport.reports[0].cost_status, "price_review_overdue");
  assert.equal(exportReport.reports[0].estimated_cost_microunits, null);
  assert.equal(exportReport.reports[0].issue_code, "DEEPSEEK_PRICE_REVIEW_OVERDUE");
});
