import { validateModelUsageObservation } from "./decisionCost.js";

export const DECISION_COST_RETENTION_SCHEMA_VERSION = "1.0.0";
export const DECISION_COST_RETENTION_DAYS = 90;
export const DEEPSEEK_PRICE_REVIEW_INTERVAL_DAYS = 30;

const REQUEST_ID_PATTERN = /^req-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const RETAINED_EVENT_NAMES = new Set([
  "model_usage_observed",
  "decision_published",
  "decision_refused",
  "evidence_verification_blocked",
  "decision_reasoning_failed",
  "intent_parse_failed",
]);

function validDateTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error("DECISION_COST_RETENTION_CRYPTO_UNAVAILABLE");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function plusDays(isoTimestamp, days) {
  const value = new Date(isoTimestamp);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString();
}

function retainedEvent(event, windowStartMs, windowEndMs) {
  if (!RETAINED_EVENT_NAMES.has(event?.event_name)) return null;
  if (!REQUEST_ID_PATTERN.test(event.request_id ?? "")) throw new Error("DECISION_COST_RETENTION_REQUEST_ID_INVALID");
  if (!validDateTime(event.server_at)) throw new Error("DECISION_COST_RETENTION_EVENT_TIME_INVALID");
  const at = Date.parse(event.server_at);
  if (at < windowStartMs || at >= windowEndMs) return null;
  if (event.event_name === "model_usage_observed") {
    const validation = validateModelUsageObservation(event.properties);
    if (!validation.valid) throw new Error(`DECISION_COST_RETENTION_USAGE_INVALID:${validation.issues.join(",")}`);
  }
  return {
    request_id: event.request_id,
    event_name: event.event_name,
    server_at: new Date(at).toISOString(),
    properties: event.event_name === "model_usage_observed" ? { ...event.properties } : null,
  };
}

async function recordWithId(record) {
  const recordSha256 = await sha256(canonicalJson(record));
  return Object.freeze({
    record_id: `cost-event-${recordSha256.slice(0, 16)}`,
    ...record,
  });
}

function batchWithoutHash(batch) {
  const { batch_sha256: omittedHash, batch_id: omittedId, ...unsigned } = batch;
  return unsigned;
}

export async function buildDecisionCostRetentionBatch({
  events,
  windowStart,
  windowEnd,
  createdAt,
  retentionDays = DECISION_COST_RETENTION_DAYS,
}) {
  if (!Array.isArray(events)) throw new Error("DECISION_COST_RETENTION_EVENTS_INVALID");
  if (![windowStart, windowEnd, createdAt].every(validDateTime)) {
    throw new Error("DECISION_COST_RETENTION_TIME_INVALID");
  }
  const windowStartMs = Date.parse(windowStart);
  const windowEndMs = Date.parse(windowEnd);
  if (windowStartMs >= windowEndMs || Date.parse(createdAt) < windowEndMs) {
    throw new Error("DECISION_COST_RETENTION_WINDOW_INVALID");
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("DECISION_COST_RETENTION_DAYS_INVALID");
  }

  const relevant = events
    .map((event) => retainedEvent(event, windowStartMs, windowEndMs))
    .filter(Boolean);
  const records = [];
  const recordIds = new Set();
  let duplicateCount = 0;
  for (const event of relevant) {
    const record = await recordWithId(event);
    if (recordIds.has(record.record_id)) {
      duplicateCount += 1;
      continue;
    }
    recordIds.add(record.record_id);
    records.push(record);
  }
  records.sort((left, right) => left.server_at.localeCompare(right.server_at)
    || left.record_id.localeCompare(right.record_id));

  const unsigned = {
    schema_version: DECISION_COST_RETENTION_SCHEMA_VERSION,
    window_start: new Date(windowStartMs).toISOString(),
    window_end: new Date(windowEndMs).toISOString(),
    created_at: new Date(createdAt).toISOString(),
    retention_days: retentionDays,
    delete_after: plusDays(windowEnd, retentionDays),
    input_event_count: events.length,
    relevant_event_count: relevant.length,
    retained_record_count: records.length,
    duplicate_event_count: duplicateCount,
    ignored_event_count: events.length - relevant.length,
    records,
  };
  const batchSha256 = await sha256(canonicalJson(unsigned));
  return Object.freeze({
    ...unsigned,
    batch_id: `cost-batch-${batchSha256.slice(0, 16)}`,
    batch_sha256: batchSha256,
  });
}

export async function verifyDecisionCostRetentionBatch(batch) {
  try {
    const expectedKeys = [
      "batch_id",
      "batch_sha256",
      "created_at",
      "delete_after",
      "duplicate_event_count",
      "ignored_event_count",
      "input_event_count",
      "records",
      "relevant_event_count",
      "retained_record_count",
      "retention_days",
      "schema_version",
      "window_end",
      "window_start",
    ];
    if (!batch || typeof batch !== "object" || Array.isArray(batch)
      || JSON.stringify(Object.keys(batch).sort()) !== JSON.stringify(expectedKeys)
      || batch.schema_version !== DECISION_COST_RETENTION_SCHEMA_VERSION
      || !/^cost-batch-[a-f0-9]{16}$/u.test(batch.batch_id ?? "")
      || !/^[a-f0-9]{64}$/u.test(batch.batch_sha256 ?? "")
      || !Array.isArray(batch.records)
      || batch.retained_record_count !== batch.records.length
      || batch.relevant_event_count !== batch.retained_record_count + batch.duplicate_event_count
      || batch.input_event_count !== batch.relevant_event_count + batch.ignored_event_count
      || batch.delete_after !== plusDays(batch.window_end, batch.retention_days)) {
      throw new Error("DECISION_COST_RETENTION_BATCH_CORRUPT");
    }
    const seen = new Set();
    for (const record of batch.records) {
      const { record_id: recordId, ...unsignedRecord } = record;
      const recordHash = await sha256(canonicalJson(unsignedRecord));
      if (recordId !== `cost-event-${recordHash.slice(0, 16)}` || seen.has(recordId)) {
        throw new Error("DECISION_COST_RETENTION_BATCH_CORRUPT");
      }
      retainedEvent(record, Date.parse(batch.window_start), Date.parse(batch.window_end));
      seen.add(recordId);
    }
    const expectedHash = await sha256(canonicalJson(batchWithoutHash(batch)));
    if (expectedHash !== batch.batch_sha256 || batch.batch_id !== `cost-batch-${expectedHash.slice(0, 16)}`) {
      throw new Error("DECISION_COST_RETENTION_BATCH_CORRUPT");
    }
    return Object.freeze({ valid: true, issue_code: null });
  } catch (error) {
    return Object.freeze({ valid: false, issue_code: "DECISION_COST_RETENTION_BATCH_CORRUPT" });
  }
}

export async function eventsFromDecisionCostRetentionBatch(batch) {
  const verification = await verifyDecisionCostRetentionBatch(batch);
  if (!verification.valid) throw new Error(verification.issue_code);
  return batch.records.map((record) => Object.freeze({
    request_id: record.request_id,
    event_name: record.event_name,
    server_at: record.server_at,
    properties: record.properties ?? {},
  }));
}

export function deepSeekPriceReviewStatus({ verifiedAt, asOf }) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(verifiedAt ?? "") || !/^\d{4}-\d{2}-\d{2}$/u.test(asOf ?? "")) {
    throw new Error("DEEPSEEK_PRICE_REVIEW_DATE_INVALID");
  }
  const verifiedMs = Date.parse(`${verifiedAt}T00:00:00Z`);
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(verifiedMs) || !Number.isFinite(asOfMs) || asOfMs < verifiedMs) {
    throw new Error("DEEPSEEK_PRICE_REVIEW_DATE_INVALID");
  }
  const due = new Date(verifiedMs);
  due.setUTCDate(due.getUTCDate() + DEEPSEEK_PRICE_REVIEW_INTERVAL_DAYS);
  const dueAt = due.toISOString().slice(0, 10);
  const status = asOf === dueAt ? "due" : asOfMs > due.getTime() ? "overdue" : "current";
  return Object.freeze({
    verified_at: verifiedAt,
    as_of: asOf,
    review_interval_days: DEEPSEEK_PRICE_REVIEW_INTERVAL_DAYS,
    next_review_due_at: dueAt,
    status,
    blocks_cost_calculation: status === "overdue",
  });
}
