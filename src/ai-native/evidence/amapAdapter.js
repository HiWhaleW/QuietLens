import { createHash } from "node:crypto";

import { createCandidateEvidence } from "./candidateEvidence.js";
import { EVIDENCE_PIPELINE_SCHEMA_VERSION } from "./pipelineContracts.js";
import { assertSourceAccessPlan } from "./sourceAccessPolicy.js";

export const AMAP_ADAPTER_ID = "adapter-amap-place-detail-v1";
export const AMAP_ACCESS_PLAN_ID = "plan-amap-place-detail-v1";
export const AMAP_API_HOST = "restapi.amap.com";
export const AMAP_PLACE_DETAIL_ENDPOINT = `https://${AMAP_API_HOST}/v5/place/detail`;
export const AMAP_KEY_ENV = "AMAP_WEB_SERVICE_KEY";
export const AMAP_NETWORK_FLAG_ENV = "AMAP_EXTERNAL_COLLECTION_ENABLED";
export const AMAP_MAX_RESPONSE_BYTES = 256 * 1024;

const AMAP_SOURCE_URN_PREFIX = "urn:quietlens:amap-place:";
const AMAP_POI_ID_PATTERN = /^[A-Z0-9]{6,32}$/;
const QUIETLENS_PLACE_ID_PATTERN = /^hp-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const coordinatePattern = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function safeExcerpt(label, value) {
  return `${label}：${String(value ?? "").replaceAll(/\s+/gu, " ").trim()}`.slice(0, 500);
}

function sanitizedInfo(value) {
  return String(value ?? "")
    .replaceAll(/([?&](?:key|sig)=)[^&\s]+/giu, "$1[REDACTED]")
    .replaceAll(/\b(?:key|sig)\s*[:=]\s*[^\s,;]+/giu, (match) => `${match.split(/[:=]/u)[0]}=[REDACTED]`)
    .slice(0, 240);
}

export class AmapAdapterError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "AmapAdapterError";
    this.code = code;
    this.details = Object.fromEntries(
      Object.entries(details).map(([key, value]) => [key, sanitizedInfo(value)]),
    );
  }

  toJSON() {
    return { name: this.name, code: this.code, details: this.details };
  }
}

export function createAmapAccessPlan({
  enabled = false,
  approvalStatus = "pending",
  termsReviewedAt = null,
  owner = "evidence-operator",
  requestsPerMinute = 0,
  maxConcurrency = 0,
} = {}) {
  return {
    schema_version: EVIDENCE_PIPELINE_SCHEMA_VERSION,
    plan_id: AMAP_ACCESS_PLAN_ID,
    adapter_id: AMAP_ADAPTER_ID,
    source_type: "map_listing",
    host: AMAP_API_HOST,
    access_mode: "official_api",
    enabled,
    approval_status: approvalStatus,
    review: {
      terms_reviewed_at: termsReviewedAt,
      robots_reviewed_at: null,
      owner,
    },
    controls: {
      bypass_captcha: false,
      reuse_authenticated_session: false,
      reverse_engineer_signature: false,
      call_private_api: false,
      rotate_identity_or_proxy: false,
      honors_retry_after: true,
      uses_cache: false,
    },
    rate_limit: { requests_per_minute: requestsPerMinute, max_concurrency: maxConcurrency },
    storage: {
      stores_personal_identifiers: false,
      stores_full_text: false,
      raw_retention_days: 0,
    },
    output_status: "candidate",
    stop_conditions: [
      "identity_mismatch",
      "permission_unclear",
      "rate_limited",
      "source_withdrawn",
      "terms_changed",
    ],
  };
}

export function registeredAmapTargets(evidenceStore) {
  const seenPoiIds = new Set();
  return (evidenceStore?.sources ?? [])
    .filter((source) => source.publisher === "高德地图" && source.url.startsWith(AMAP_SOURCE_URN_PREFIX))
    .map((source) => {
      const amapPoiId = source.url.slice(AMAP_SOURCE_URN_PREFIX.length);
      if (!AMAP_POI_ID_PATTERN.test(amapPoiId)) {
        throw new AmapAdapterError("AMAP_POI_ID_INVALID", { source_id: source.source_id });
      }
      if (source.supports_place_ids.length !== 1 || !QUIETLENS_PLACE_ID_PATTERN.test(source.supports_place_ids[0])) {
        throw new AmapAdapterError("AMAP_SOURCE_SCOPE_INVALID", { source_id: source.source_id });
      }
      if (seenPoiIds.has(amapPoiId)) {
        throw new AmapAdapterError("AMAP_POI_ID_DUPLICATE", { source_id: source.source_id });
      }
      seenPoiIds.add(amapPoiId);
      return Object.freeze({
        source_id: source.source_id,
        place_id: source.supports_place_ids[0],
        amap_poi_id: amapPoiId,
        source_url: source.url,
      });
    })
    .sort((left, right) => left.source_id.localeCompare(right.source_id));
}

export function assertAmapRuntimeReady({ env = {}, accessPlan, fetchImpl }) {
  const issues = [];
  if (env[AMAP_NETWORK_FLAG_ENV] !== "true") issues.push("NETWORK_NOT_AUTHORIZED");
  if (!String(env[AMAP_KEY_ENV] ?? "").trim()) issues.push("KEY_NOT_CONFIGURED");
  if (typeof fetchImpl !== "function") issues.push("NETWORK_CLIENT_NOT_INJECTED");
  if (!accessPlan || accessPlan.adapter_id !== AMAP_ADAPTER_ID || accessPlan.plan_id !== AMAP_ACCESS_PLAN_ID) {
    issues.push("ACCESS_PLAN_MISMATCH");
  } else {
    try {
      assertSourceAccessPlan(accessPlan);
    } catch {
      issues.push("ACCESS_PLAN_NOT_APPROVED");
    }
    if (accessPlan.host !== AMAP_API_HOST || accessPlan.access_mode !== "official_api") {
      issues.push("ACCESS_PLAN_HOST_INVALID");
    }
    if (accessPlan.enabled !== true || accessPlan.approval_status !== "approved") {
      issues.push("ACCESS_PLAN_DISABLED");
    }
  }
  if (issues.length) throw new AmapAdapterError("AMAP_RUNTIME_BLOCKED", { issues: issues.join(",") });
  return true;
}

function buildSecretRequestUrl(amapPoiId, key) {
  const url = new URL(AMAP_PLACE_DETAIL_ENDPOINT);
  url.searchParams.set("id", amapPoiId);
  url.searchParams.set("key", key);
  url.searchParams.set("output", "json");
  return url;
}

function normalizeLocation(location, amapPoiId) {
  const match = String(location ?? "").match(coordinatePattern);
  if (!match) throw new AmapAdapterError("AMAP_COORDINATES_INVALID", { amap_poi_id: amapPoiId });
  const longitude = Number(match[1]);
  const latitude = Number(match[2]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)
    || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new AmapAdapterError("AMAP_COORDINATES_INVALID", { amap_poi_id: amapPoiId });
  }
  return Object.freeze({ longitude, latitude, coordinate_system: "GCJ-02" });
}

function normalizePlace(poi, target) {
  if (!poi || typeof poi !== "object" || Array.isArray(poi)) {
    throw new AmapAdapterError("AMAP_POI_INVALID", { amap_poi_id: target.amap_poi_id });
  }
  if (poi.id !== target.amap_poi_id) {
    throw new AmapAdapterError("AMAP_IDENTITY_MISMATCH", { amap_poi_id: target.amap_poi_id });
  }
  const name = String(poi.name ?? "").trim();
  const address = String(poi.address ?? "").trim();
  if (!name) throw new AmapAdapterError("AMAP_NAME_MISSING", { amap_poi_id: target.amap_poi_id });
  return Object.freeze({
    amap_poi_id: target.amap_poi_id,
    source_id: target.source_id,
    place_id: target.place_id,
    name,
    address: address || null,
    location: normalizeLocation(poi.location, target.amap_poi_id),
  });
}

function parseAmapResponse(responseText, target) {
  if (utf8Length(responseText) > AMAP_MAX_RESPONSE_BYTES) {
    throw new AmapAdapterError("AMAP_RESPONSE_TOO_LARGE");
  }
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new AmapAdapterError("AMAP_RESPONSE_INVALID_JSON");
  }
  if (payload?.status !== "1" || payload?.infocode !== "10000") {
    throw new AmapAdapterError("AMAP_PROVIDER_REJECTED", {
      infocode: payload?.infocode ?? "unknown",
    });
  }
  if (!Array.isArray(payload.pois) || payload.pois.length !== 1) {
    throw new AmapAdapterError("AMAP_POI_RESULT_COUNT_INVALID", { count: payload?.pois?.length ?? "unknown" });
  }
  return normalizePlace(payload.pois[0], target);
}

export async function fetchAmapPlaceDetail({ target, env = {}, accessPlan, fetchImpl }) {
  assertAmapRuntimeReady({ env, accessPlan, fetchImpl });
  if (!target || !AMAP_POI_ID_PATTERN.test(target.amap_poi_id ?? "")
    || !QUIETLENS_PLACE_ID_PATTERN.test(target.place_id ?? "")
    || !/^src-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.source_id ?? "")
    || target.source_url !== `${AMAP_SOURCE_URN_PREFIX}${target.amap_poi_id}`) {
    throw new AmapAdapterError("AMAP_TARGET_INVALID");
  }
  const requestUrl = buildSecretRequestUrl(target.amap_poi_id, env[AMAP_KEY_ENV].trim());
  let response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
    });
  } catch {
    throw new AmapAdapterError("AMAP_NETWORK_FAILED");
  }
  if (!response?.ok) {
    throw new AmapAdapterError(response?.status === 429 ? "AMAP_RATE_LIMITED" : "AMAP_HTTP_FAILED", {
      http_status: response?.status ?? "unknown",
    });
  }
  return parseAmapResponse(await response.text(), target);
}

export function createAmapCollectionBundle({ normalizedPlace, target, accessPlan, capturedAt }) {
  if (!normalizedPlace || normalizedPlace.amap_poi_id !== target?.amap_poi_id
    || normalizedPlace.source_id !== target.source_id || normalizedPlace.place_id !== target.place_id) {
    throw new AmapAdapterError("AMAP_COLLECTION_SCOPE_MISMATCH");
  }
  if (accessPlan?.adapter_id !== AMAP_ADAPTER_ID || accessPlan?.plan_id !== AMAP_ACCESS_PLAN_ID) {
    throw new AmapAdapterError("AMAP_ACCESS_PLAN_MISMATCH");
  }
  const minimalPayload = stableJson(normalizedPlace);
  const fingerprint = sha256(`${target.source_id}|${capturedAt}|${minimalPayload}`);
  const shortId = fingerprint.slice(0, 16);
  const runId = `run-amap-${shortId}`;
  const snapshotId = `snap-amap-${shortId}`;
  const snapshot = {
    schema_version: EVIDENCE_PIPELINE_SCHEMA_VERSION,
    snapshot_id: snapshotId,
    run_id: runId,
    source_id: target.source_id,
    access_plan_id: accessPlan.plan_id,
    captured_at: capturedAt,
    status: "captured",
    source_url: target.source_url,
    http_status: 200,
    content_type: "application/json",
    content_length: utf8Length(minimalPayload),
    content_sha256: sha256(minimalPayload),
    payload_ref: `urn:quietlens:raw:amap-${shortId}`,
    storage_mode: "metadata_excerpt",
    personal_data_status: "none",
    ugc_full_text_stored: false,
    error_code: null,
    retry_after_at: null,
  };
  const run = {
    schema_version: EVIDENCE_PIPELINE_SCHEMA_VERSION,
    run_id: runId,
    source_id: target.source_id,
    access_plan_id: accessPlan.plan_id,
    adapter_id: accessPlan.adapter_id,
    trigger: "manual",
    started_at: capturedAt,
    finished_at: capturedAt,
    status: "captured",
    request_count: 1,
    snapshot_ids: [snapshotId],
    error_code: null,
    external_network_used: true,
  };
  const draftBase = {
    snapshot_id: snapshotId,
    place_id_hint: target.place_id,
    place_hints: [normalizedPlace.name],
    branch_context_confirmed: true,
    observed_at: capturedAt,
    published_at: null,
    applicable_time: null,
    extraction_method: "deterministic",
    extraction_model: null,
    contains_personal_identifiers: false,
  };
  const candidateDrafts = [
    {
      ...draftBase,
      attribute: "identity",
      source_excerpt_untrusted: safeExcerpt("高德 POI 名称候选", normalizedPlace.name),
      normalized_value: normalizedPlace.name,
    },
    ...(normalizedPlace.address ? [{
      ...draftBase,
      attribute: "address",
      source_excerpt_untrusted: safeExcerpt("高德 POI 地址候选", normalizedPlace.address),
      normalized_value: normalizedPlace.address,
    }] : []),
    {
      ...draftBase,
      attribute: "coordinates",
      source_excerpt_untrusted: safeExcerpt(
        "高德 GCJ-02 坐标候选",
        `${normalizedPlace.location.longitude},${normalizedPlace.location.latitude}`,
      ),
      normalized_value: [normalizedPlace.location.latitude, normalizedPlace.location.longitude],
    },
  ];
  return Object.freeze({ run: Object.freeze(run), snapshot: Object.freeze(snapshot), candidate_drafts: Object.freeze(candidateDrafts) });
}

export function materializeAmapCandidates(bundle, pipelineState, evidenceStore) {
  if (!bundle?.snapshot || !Array.isArray(bundle.candidate_drafts)) {
    throw new AmapAdapterError("AMAP_CANDIDATE_INPUT_INVALID");
  }
  return bundle.candidate_drafts.map((draft) => createCandidateEvidence(draft, pipelineState, evidenceStore));
}
