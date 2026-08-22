import { assertAnalyticsEvent, SERVER_ONLY_EVENT_NAMES } from "./eventContract.js";
import {
  analyticsRetentionMetadata,
  STAGE3_ANALYTICS_RETENTION_DAYS,
} from "./stage3AnalyticsDashboard.js";

export const BROWSER_ANALYTICS_STORE_SCHEMA_VERSION = "1.0.0";
export const BROWSER_ANALYTICS_STORAGE_KEY = "quietlens_beta_analytics_v1";
export const BROWSER_ANALYTICS_MAX_BYTES = 4 * 1024 * 1024;

const SERVER_ONLY_EVENTS = new Set(SERVER_ONLY_EVENT_NAMES);

function storageOrDefault(storage) {
  const resolved = storage ?? globalThis.localStorage;
  if (!resolved?.getItem || !resolved?.setItem || !resolved?.removeItem) {
    throw new Error("ANALYTICS_BROWSER_STORAGE_UNAVAILABLE");
  }
  return resolved;
}

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function eventFingerprint(event) {
  return [event.event_name, event.session_id, event.request_id, event.server_at].join("|");
}

function emptyState() {
  return {
    schema_version: BROWSER_ANALYTICS_STORE_SCHEMA_VERSION,
    retention_days: STAGE3_ANALYTICS_RETENTION_DAYS,
    dropped_event_count: 0,
    events: [],
  };
}

function assertRecord(record) {
  if (record?.type !== "quietlens_analytics"
    || record.retention_days !== STAGE3_ANALYTICS_RETENTION_DAYS
    || typeof record.expires_at !== "string") {
    throw new Error("ANALYTICS_BROWSER_STORAGE_CORRUPT");
  }
  const event = assertAnalyticsEvent(record.event);
  if (SERVER_ONLY_EVENTS.has(event.event_name)) {
    throw new Error("ANALYTICS_BROWSER_EVENT_SERVER_ONLY");
  }
  const expectedExpiry = analyticsRetentionMetadata(event.server_at).expires_at;
  if (record.expires_at !== expectedExpiry) {
    throw new Error("ANALYTICS_BROWSER_STORAGE_CORRUPT");
  }
  return record;
}

function parseState(raw) {
  if (raw === null) return emptyState();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("ANALYTICS_BROWSER_STORAGE_CORRUPT");
  }
  if (value?.schema_version !== BROWSER_ANALYTICS_STORE_SCHEMA_VERSION
    || value.retention_days !== STAGE3_ANALYTICS_RETENTION_DAYS
    || !Number.isSafeInteger(value.dropped_event_count)
    || value.dropped_event_count < 0
    || !Array.isArray(value.events)) {
    throw new Error("ANALYTICS_BROWSER_STORAGE_CORRUPT");
  }
  return {
    ...value,
    events: value.events.map(assertRecord),
  };
}

function activeEvents(state, nowMs) {
  const fingerprints = new Set();
  const events = [];
  for (const record of state.events) {
    const expiresAtMs = Date.parse(record.expires_at);
    if (!Number.isFinite(expiresAtMs)) throw new Error("ANALYTICS_BROWSER_STORAGE_CORRUPT");
    if (expiresAtMs <= nowMs) continue;
    const fingerprint = eventFingerprint(record.event);
    if (fingerprints.has(fingerprint)) continue;
    fingerprints.add(fingerprint);
    events.push(record);
  }
  return events.sort((left, right) => left.event.server_at.localeCompare(right.event.server_at));
}

function writeBoundedState(storage, state, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
    throw new Error("ANALYTICS_BROWSER_MAX_BYTES_INVALID");
  }
  const next = { ...state, events: [...state.events] };
  let serialized = JSON.stringify(next);
  while (next.events.length && byteLength(serialized) > maxBytes) {
    next.events.shift();
    next.dropped_event_count += 1;
    serialized = JSON.stringify(next);
  }
  if (byteLength(serialized) > maxBytes) {
    throw new Error("ANALYTICS_BROWSER_MAX_BYTES_INVALID");
  }
  storage.setItem(BROWSER_ANALYTICS_STORAGE_KEY, serialized);
  return Object.freeze({
    stored_event_count: next.events.length,
    dropped_event_count: next.dropped_event_count,
    bytes: byteLength(serialized),
  });
}

export function appendBrowserAnalyticsEvent(event, {
  storage,
  now = new Date().toISOString(),
  maxBytes = BROWSER_ANALYTICS_MAX_BYTES,
} = {}) {
  const validated = assertAnalyticsEvent(event);
  if (SERVER_ONLY_EVENTS.has(validated.event_name)) {
    throw new Error("ANALYTICS_BROWSER_EVENT_SERVER_ONLY");
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("ANALYTICS_BROWSER_TIME_INVALID");
  const resolvedStorage = storageOrDefault(storage);
  const state = parseState(resolvedStorage.getItem(BROWSER_ANALYTICS_STORAGE_KEY));
  const events = activeEvents(state, nowMs);
  const fingerprint = eventFingerprint(validated);
  const retention = analyticsRetentionMetadata(validated.server_at);
  if (Date.parse(retention.expires_at) > nowMs
    && !events.some((record) => eventFingerprint(record.event) === fingerprint)) {
    events.push(Object.freeze({
      type: "quietlens_analytics",
      ...retention,
      event: validated,
    }));
    events.sort((left, right) => left.event.server_at.localeCompare(right.event.server_at));
  }
  return writeBoundedState(resolvedStorage, { ...state, events }, maxBytes);
}

export function readBrowserAnalyticsEvents({ storage, now = new Date().toISOString() } = {}) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("ANALYTICS_BROWSER_TIME_INVALID");
  const resolvedStorage = storageOrDefault(storage);
  const state = parseState(resolvedStorage.getItem(BROWSER_ANALYTICS_STORAGE_KEY));
  const events = activeEvents(state, nowMs);
  writeBoundedState(resolvedStorage, { ...state, events }, BROWSER_ANALYTICS_MAX_BYTES);
  return Object.freeze(events.map((record) => Object.freeze(record)));
}

export function buildBrowserAnalyticsExport({ storage, now = new Date().toISOString() } = {}) {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("ANALYTICS_BROWSER_TIME_INVALID");
  const resolvedStorage = storageOrDefault(storage);
  const state = parseState(resolvedStorage.getItem(BROWSER_ANALYTICS_STORAGE_KEY));
  const events = activeEvents(state, nowMs);
  const summary = writeBoundedState(
    resolvedStorage,
    { ...state, events },
    BROWSER_ANALYTICS_MAX_BYTES,
  );
  return Object.freeze({
    schema_version: BROWSER_ANALYTICS_STORE_SCHEMA_VERSION,
    exported_at: now,
    retention_days: STAGE3_ANALYTICS_RETENTION_DAYS,
    source: "browser_local_user_export",
    dropped_event_count: summary.dropped_event_count,
    events,
  });
}

export function serializeBrowserAnalyticsExport(options) {
  return `${JSON.stringify(buildBrowserAnalyticsExport(options))}\n`;
}

export function buildBrowserAnalyticsDownload(options) {
  const exported = buildBrowserAnalyticsExport(options);
  return Object.freeze({
    filename: `quietlens-beta-analytics-${exported.exported_at.slice(0, 10)}.json`,
    mime_type: "application/json",
    event_count: exported.events.length,
    dropped_event_count: exported.dropped_event_count,
    contents: `${JSON.stringify(exported)}\n`,
  });
}

export function clearBrowserAnalyticsEvents({ storage } = {}) {
  storageOrDefault(storage).removeItem(BROWSER_ANALYTICS_STORAGE_KEY);
}
