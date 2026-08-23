import { validateAnalyticsEvent } from "./eventContract.js";

export const STAGE3_ANALYTICS_DASHBOARD_SCHEMA_VERSION = "1.0.0";
export const STAGE3_ANALYTICS_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

function unwrapEvent(record) {
  if (record?.type === "quietlens_analytics" && record.event) return record.event;
  if (typeof record?.content === "string") {
    try {
      return unwrapEvent(JSON.parse(record.content));
    } catch {
      return record;
    }
  }
  return record;
}

function recordsFromParsed(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.events)) return value.events;
  return [value];
}

function droppedCountFromParsed(value) {
  return Number.isSafeInteger(value?.dropped_event_count) && value.dropped_event_count >= 0
    ? value.dropped_event_count
    : 0;
}

export function parseAnalyticsLogExport(text) {
  if (typeof text !== "string") throw new Error("ANALYTICS_EXPORT_INVALID");
  const trimmed = text.trim();
  if (!trimmed) return Object.freeze({
    records: Object.freeze([]),
    parse_error_count: 0,
    declared_dropped_event_count: 0,
  });

  try {
    const parsed = JSON.parse(trimmed);
    const records = recordsFromParsed(parsed);
    return Object.freeze({
      records: Object.freeze(records),
      parse_error_count: 0,
      declared_dropped_event_count: droppedCountFromParsed(parsed),
    });
  } catch {
    const records = [];
    let parseErrorCount = 0;
    let declaredDroppedEventCount = 0;
    for (const line of trimmed.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        records.push(...recordsFromParsed(parsed));
        declaredDroppedEventCount += droppedCountFromParsed(parsed);
      } catch {
        parseErrorCount += 1;
      }
    }
    return Object.freeze({
      records: Object.freeze(records),
      parse_error_count: parseErrorCount,
      declared_dropped_event_count: declaredDroppedEventCount,
    });
  }
}

export function analyticsRetentionMetadata(serverAt = new Date().toISOString()) {
  const serverAtMs = Date.parse(serverAt);
  if (!Number.isFinite(serverAtMs)) throw new Error("ANALYTICS_RETENTION_TIME_INVALID");
  return Object.freeze({
    retention_days: STAGE3_ANALYTICS_RETENTION_DAYS,
    expires_at: new Date(serverAtMs + STAGE3_ANALYTICS_RETENTION_DAYS * DAY_MS).toISOString(),
  });
}

function emptyDaily(date) {
  return {
    date,
    event_count: 0,
    active_session_count: 0,
    decision_request_count: 0,
    completion_count: 0,
  };
}

export function buildStage3AnalyticsDashboard(records, { now = new Date().toISOString() } = {}) {
  if (!Array.isArray(records)) throw new Error("ANALYTICS_RECORDS_INVALID");
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("ANALYTICS_DASHBOARD_TIME_INVALID");
  const fromMs = nowMs - STAGE3_ANALYTICS_RETENTION_DAYS * DAY_MS;
  const uniqueEvents = new Set();
  const sessions = new Set();
  const daily = new Map();
  const dailySessions = new Map();
  const metrics = {
    event_count: 0,
    active_session_count: 0,
    decision_request_count: 0,
    brief_view_count: 0,
    completion_count: 0,
    published_decision_count: 0,
    refused_decision_count: 0,
    correction_count: 0,
    place_detail_open_count: 0,
    feedback_candidate_count: 0,
    model_call_count: 0,
    total_tokens: 0,
  };
  const ignored = {
    invalid_record_count: 0,
    outside_retention_count: 0,
    duplicate_record_count: 0,
  };

  for (const record of records) {
    const event = unwrapEvent(record);
    const validation = validateAnalyticsEvent(event);
    const atMs = Date.parse(event?.server_at);
    if (!validation.valid || !Number.isFinite(atMs)) {
      ignored.invalid_record_count += 1;
      continue;
    }
    if (atMs < fromMs || atMs > nowMs + FUTURE_TOLERANCE_MS) {
      ignored.outside_retention_count += 1;
      continue;
    }
    const fingerprint = [event.event_name, event.session_id, event.request_id, event.server_at].join("|");
    if (uniqueEvents.has(fingerprint)) {
      ignored.duplicate_record_count += 1;
      continue;
    }
    uniqueEvents.add(fingerprint);

    metrics.event_count += 1;
    sessions.add(event.session_id);
    const date = new Date(atMs).toISOString().slice(0, 10);
    const day = daily.get(date) ?? emptyDaily(date);
    const daySessions = dailySessions.get(date) ?? new Set();
    day.event_count += 1;
    daySessions.add(event.session_id);
    daily.set(date, day);
    dailySessions.set(date, daySessions);

    if (event.event_name === "decision_request_submitted") {
      metrics.decision_request_count += 1;
      day.decision_request_count += 1;
    }
    if (event.event_name === "decision_brief_viewed") metrics.brief_view_count += 1;
    if (event.event_name === "decision_published") {
      metrics.published_decision_count += 1;
      metrics.completion_count += 1;
      day.completion_count += 1;
    }
    if (event.event_name === "decision_refused") {
      metrics.refused_decision_count += 1;
      metrics.completion_count += 1;
      day.completion_count += 1;
    }
    if (event.event_name === "correction_submitted") metrics.correction_count += 1;
    if (event.event_name === "place_detail_opened") metrics.place_detail_open_count += 1;
    if (event.event_name === "feedback_candidate_submitted") metrics.feedback_candidate_count += 1;
    if (event.event_name === "model_usage_observed") {
      metrics.model_call_count += event.properties.model_call_count;
      metrics.total_tokens += event.properties.total_tokens;
    }
  }

  metrics.active_session_count = sessions.size;
  const dailyRows = [...daily.values()]
    .map((row) => ({ ...row, active_session_count: dailySessions.get(row.date).size }))
    .sort((left, right) => left.date.localeCompare(right.date));
  const completionRate = metrics.decision_request_count
    ? Number((metrics.completion_count / metrics.decision_request_count).toFixed(4))
    : 0;

  return Object.freeze({
    schema_version: STAGE3_ANALYTICS_DASHBOARD_SCHEMA_VERSION,
    retention_days: STAGE3_ANALYTICS_RETENTION_DAYS,
    window: Object.freeze({
      from: new Date(fromMs).toISOString(),
      to: new Date(nowMs).toISOString(),
    }),
    metrics: Object.freeze(metrics),
    funnel: Object.freeze({
      submitted_count: metrics.decision_request_count,
      brief_view_count: metrics.brief_view_count,
      completion_count: metrics.completion_count,
      completion_rate: completionRate,
    }),
    daily: Object.freeze(dailyRows.map((row) => Object.freeze(row))),
    ignored: Object.freeze(ignored),
  });
}

export function buildStage3AnalyticsDashboardFromExport(text, options) {
  const parsed = parseAnalyticsLogExport(text);
  const dashboard = buildStage3AnalyticsDashboard(parsed.records, options);
  return Object.freeze({
    ...dashboard,
    source_export_count: 1,
    parse_error_count: parsed.parse_error_count,
    declared_dropped_event_count: parsed.declared_dropped_event_count,
  });
}

export function buildStage3AnalyticsDashboardFromExports(texts, options) {
  if (!Array.isArray(texts)) throw new Error("ANALYTICS_EXPORTS_INVALID");
  const records = [];
  const uniqueExports = new Set();
  let parseErrorCount = 0;
  let declaredDroppedEventCount = 0;
  let duplicateSourceExportCount = 0;
  for (const text of texts) {
    if (uniqueExports.has(text)) {
      duplicateSourceExportCount += 1;
      continue;
    }
    uniqueExports.add(text);
    const parsed = parseAnalyticsLogExport(text);
    records.push(...parsed.records);
    parseErrorCount += parsed.parse_error_count;
    declaredDroppedEventCount += parsed.declared_dropped_event_count;
  }
  const dashboard = buildStage3AnalyticsDashboard(records, options);
  return Object.freeze({
    ...dashboard,
    source_export_count: uniqueExports.size,
    duplicate_source_export_count: duplicateSourceExportCount,
    parse_error_count: parseErrorCount,
    declared_dropped_event_count: declaredDroppedEventCount,
  });
}
