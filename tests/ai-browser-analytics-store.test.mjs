import assert from "node:assert/strict";
import test from "node:test";

import {
  appendBrowserAnalyticsEvent,
  BROWSER_ANALYTICS_STORAGE_KEY,
  buildBrowserAnalyticsExport,
  buildBrowserAnalyticsDownload,
  clearBrowserAnalyticsEvents,
  readBrowserAnalyticsEvents,
} from "../src/ai-native/analytics/browserAnalyticsStore.js";
import { buildStage3AnalyticsDashboardFromExport } from "../src/ai-native/analytics/stage3AnalyticsDashboard.js";

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

function event(eventName, at, properties, requestId = "req-browser-001") {
  return {
    event_name: eventName,
    event_schema_version: "1.0.0",
    session_id: "sess-browser-001",
    request_id: requestId,
    experience_stage: "F4",
    model_version: "not-invoked",
    prompt_version: "not-invoked",
    contract_schema_version: "1.0.0",
    evidence_store_version: "0.1.0",
    client_at: at,
    server_at: at,
    error_code: null,
    properties,
  };
}

const submitted = (at, requestId) => event("decision_request_submitted", at, {
  input_length_bucket: "short",
  entry_context: "primary_composer",
}, requestId);

test("keeps valid browser analytics locally for 30 days and exports dashboard-compatible JSON", () => {
  const storage = new MemoryStorage();
  appendBrowserAnalyticsEvent(submitted("2026-08-20T12:00:00.000Z"), {
    storage,
    now: "2026-08-20T12:00:00.000Z",
  });
  appendBrowserAnalyticsEvent(event("decision_brief_viewed", "2026-08-20T12:00:01.000Z", {
    candidate_count: 2,
    unknown_count: 1,
    assumption_count: 0,
  }), { storage, now: "2026-08-20T12:00:01.000Z" });

  const exported = buildBrowserAnalyticsExport({ storage, now: "2026-08-22T12:00:00.000Z" });
  assert.equal(exported.retention_days, 30);
  assert.equal(exported.source, "browser_local_user_export");
  assert.equal(exported.dropped_event_count, 0);
  assert.equal(exported.events.length, 2);
  assert.equal(JSON.stringify(exported).includes("invite"), false);
  assert.equal(JSON.stringify(exported).includes("participant"), false);

  const dashboard = buildStage3AnalyticsDashboardFromExport(JSON.stringify(exported), {
    now: "2026-08-22T12:00:00.000Z",
  });
  assert.equal(dashboard.metrics.event_count, 2);
  assert.equal(dashboard.metrics.decision_request_count, 1);
  assert.equal(dashboard.metrics.brief_view_count, 1);
});

test("keeps the rejected browser-export prototype reproducible as archived evidence", () => {
  const storage = new MemoryStorage();
  appendBrowserAnalyticsEvent(submitted("2026-08-20T12:00:00.000Z"), {
    storage,
    now: "2026-08-20T12:00:00.000Z",
  });

  const download = buildBrowserAnalyticsDownload({
    storage,
    now: "2026-08-22T12:00:00.000Z",
  });
  assert.equal(download.filename, "quietlens-beta-analytics-2026-08-22.json");
  assert.equal(download.mime_type, "application/json");
  assert.equal(download.event_count, 1);
  assert.equal(download.dropped_event_count, 0);
  assert.equal(JSON.parse(download.contents).events.length, 1);
  assert.equal(download.filename.includes("session"), false);
  assert.equal(download.filename.includes("participant"), false);
});

test("purges expired events and removes exact duplicates", () => {
  const storage = new MemoryStorage();
  const old = submitted("2026-07-01T12:00:00.000Z", "req-old");
  const current = submitted("2026-08-20T12:00:00.000Z", "req-current");
  appendBrowserAnalyticsEvent(old, { storage, now: "2026-07-01T12:00:00.000Z" });
  appendBrowserAnalyticsEvent(current, { storage, now: "2026-08-20T12:00:00.000Z" });
  appendBrowserAnalyticsEvent(current, { storage, now: "2026-08-20T12:00:01.000Z" });

  const records = readBrowserAnalyticsEvents({ storage, now: "2026-08-22T12:00:00.000Z" });
  assert.equal(records.length, 1);
  assert.equal(records[0].event.request_id, "req-current");
});

test("expires records exactly at the 30-day boundary", () => {
  const storage = new MemoryStorage();
  const at = "2026-07-23T12:00:00.000Z";
  appendBrowserAnalyticsEvent(submitted(at, "req-boundary"), { storage, now: at });

  const beforeBoundary = readBrowserAnalyticsEvents({
    storage,
    now: "2026-08-22T11:59:59.999Z",
  });
  assert.equal(beforeBoundary.length, 1);

  const atBoundary = readBrowserAnalyticsEvents({
    storage,
    now: "2026-08-22T12:00:00.000Z",
  });
  assert.equal(atBoundary.length, 0);

  appendBrowserAnalyticsEvent(submitted(at, "req-expired-on-arrival"), {
    storage,
    now: "2026-08-22T12:00:00.000Z",
  });
  assert.equal(readBrowserAnalyticsEvents({
    storage,
    now: "2026-08-22T12:00:00.000Z",
  }).length, 0);
});

test("fails closed on corrupt state and requires an explicit clear", () => {
  const storage = new MemoryStorage();
  storage.setItem(BROWSER_ANALYTICS_STORAGE_KEY, "not-json");
  assert.throws(() => appendBrowserAnalyticsEvent(
    submitted("2026-08-20T12:00:00.000Z"),
    { storage, now: "2026-08-20T12:00:00.000Z" },
  ), /ANALYTICS_BROWSER_STORAGE_CORRUPT/u);
  assert.equal(storage.getItem(BROWSER_ANALYTICS_STORAGE_KEY), "not-json");

  clearBrowserAnalyticsEvents({ storage });
  appendBrowserAnalyticsEvent(submitted("2026-08-20T12:00:00.000Z"), {
    storage,
    now: "2026-08-20T12:00:00.000Z",
  });
  assert.equal(readBrowserAnalyticsEvents({ storage, now: "2026-08-20T12:00:00.000Z" }).length, 1);
});

test("rejects server-only cost events and privacy-invalid events", () => {
  const storage = new MemoryStorage();
  const serverOnly = event("model_usage_observed", "2026-08-20T12:00:00.000Z", {
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
  });
  assert.throws(() => appendBrowserAnalyticsEvent(serverOnly, { storage }), /ANALYTICS_BROWSER_EVENT_SERVER_ONLY/u);

  const invalid = submitted("2026-08-20T12:00:00.000Z");
  invalid.properties.invite_code = "synthetic-secret-value";
  assert.throws(() => appendBrowserAnalyticsEvent(invalid, { storage }), /EVENT_/u);
  assert.equal(storage.getItem(BROWSER_ANALYTICS_STORAGE_KEY), null);
});

test("keeps the newest valid events inside a strict byte budget", () => {
  const storage = new MemoryStorage();
  let lastResult;
  for (let index = 0; index < 12; index += 1) {
    lastResult = appendBrowserAnalyticsEvent(submitted(
      `2026-08-20T12:00:${String(index).padStart(2, "0")}.000Z`,
      `req-browser-${String(index).padStart(3, "0")}`,
    ), {
      storage,
      now: `2026-08-20T12:00:${String(index).padStart(2, "0")}.000Z`,
      maxBytes: 1800,
    });
  }
  assert.ok(lastResult.dropped_event_count > 0);
  assert.ok(lastResult.bytes <= 1800);
  const exported = buildBrowserAnalyticsExport({
    storage,
    now: "2026-08-20T12:01:00.000Z",
  });
  assert.equal(exported.dropped_event_count, lastResult.dropped_event_count);
  const records = readBrowserAnalyticsEvents({ storage, now: "2026-08-20T12:01:00.000Z" });
  assert.equal(records.at(-1).event.request_id, "req-browser-011");
});

test("keeps newer records when an older event arrives out of order", () => {
  const storage = new MemoryStorage();
  for (let index = 5; index < 12; index += 1) {
    appendBrowserAnalyticsEvent(submitted(
      `2026-08-20T12:00:${String(index).padStart(2, "0")}.000Z`,
      `req-newer-${String(index).padStart(3, "0")}`,
    ), {
      storage,
      now: "2026-08-20T12:01:00.000Z",
      maxBytes: 1800,
    });
  }
  appendBrowserAnalyticsEvent(submitted(
    "2026-08-20T12:00:01.000Z",
    "req-older-late",
  ), {
    storage,
    now: "2026-08-20T12:01:00.000Z",
    maxBytes: 1800,
  });

  const records = readBrowserAnalyticsEvents({ storage, now: "2026-08-20T12:01:00.000Z" });
  assert.equal(records.some((record) => record.event.request_id === "req-older-late"), false);
  assert.equal(records.at(-1).event.request_id, "req-newer-011");
});
