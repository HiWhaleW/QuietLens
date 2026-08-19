import {
  EVIDENCE_PIPELINE_SCHEMA_VERSION,
  EVIDENCE_PIPELINE_TARGET_VERSION,
} from "./pipelineContracts.js";
import { SOURCE_ACCESS_POLICY_VERSION } from "./sourceAccessPolicy.js";

export const SOURCE_TYPE_PERMITTED_ATTRIBUTES = Object.freeze({
  map_listing: Object.freeze(["identity", "address", "coordinates", "operating_status", "opening_hours"]),
  signed_reporting: Object.freeze([
    "identity", "address", "operating_status", "opening_hours", "facade", "interior", "size",
    "workspace", "daylight", "seating", "outlets", "outdoor_seating", "noise", "crowding",
    "peak_time", "call_environment",
  ]),
  brand_interview: Object.freeze([
    "identity", "address", "facade", "interior", "size", "workspace", "daylight", "seating",
    "outlets", "outdoor_seating",
  ]),
  editorial_guide: Object.freeze([
    "identity", "address", "facade", "interior", "size", "workspace", "daylight", "seating",
    "outlets", "outdoor_seating", "noise", "crowding", "peak_time", "call_environment",
  ]),
  traceable_ugc: Object.freeze([
    "operating_status", "opening_hours", "facade", "interior", "workspace", "daylight", "seating",
    "outlets", "outdoor_seating", "noise", "crowding", "peak_time", "call_environment",
  ]),
  official_page: Object.freeze([
    "identity", "address", "operating_status", "opening_hours", "facade", "interior", "size",
    "workspace", "seating", "outlets", "outdoor_seating",
  ]),
  address_reference: Object.freeze(["address"]),
  curated_registry: Object.freeze(["identity", "address", "coordinates"]),
});

function slug(value) {
  return value.replaceAll("_", "-");
}

export function accessPlanIdForSourceType(sourceType) {
  return `plan-manual-${slug(sourceType)}-v1`;
}

export function createManualAccessPlan(sourceType) {
  const internal = sourceType === "curated_registry";
  return {
    schema_version: EVIDENCE_PIPELINE_SCHEMA_VERSION,
    plan_id: accessPlanIdForSourceType(sourceType),
    adapter_id: `adapter-${internal ? "internal" : "manual"}-${slug(sourceType)}`,
    source_type: sourceType,
    host: "",
    access_mode: internal ? "internal_registry" : "manual_research",
    enabled: true,
    approval_status: "approved",
    review: {
      terms_reviewed_at: null,
      robots_reviewed_at: null,
      owner: "evidence-operator",
    },
    controls: {
      bypass_captcha: false,
      reuse_authenticated_session: false,
      reverse_engineer_signature: false,
      call_private_api: false,
      rotate_identity_or_proxy: false,
      honors_retry_after: false,
      uses_cache: false,
    },
    rate_limit: { requests_per_minute: 0, max_concurrency: 0 },
    storage: {
      stores_personal_identifiers: false,
      stores_full_text: false,
      raw_retention_days: 0,
    },
    output_status: "candidate",
    stop_conditions: ["identity_mismatch", "permission_unclear", "source_withdrawn"],
  };
}

function sourceHost(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function createSourceRegistryEntry(source) {
  const attributes = SOURCE_TYPE_PERMITTED_ATTRIBUTES[source.source_type];
  if (!attributes) throw new Error(`No permitted-attribute policy for ${source.source_type}`);
  return {
    schema_version: EVIDENCE_PIPELINE_SCHEMA_VERSION,
    source_id: source.source_id,
    source_record_version: source.schema_version,
    source_type: source.source_type,
    canonical_host: sourceHost(source.url),
    collection_status: "manual_only",
    access_plan_id: accessPlanIdForSourceType(source.source_type),
    permitted_attributes: [...attributes],
    usage_restrictions: source.usage_restrictions,
    owner: "evidence-operator",
    last_reviewed_at: source.accessed_at,
    next_review_due_at: null,
    supports_place_ids: [...source.supports_place_ids],
  };
}

export function buildEvidencePipelineBaseline(evidenceStore, generatedAt = "2026-08-18T00:00:00+08:00") {
  const sourceTypes = [...new Set(evidenceStore.sources.map((source) => source.source_type))].sort();
  const accessPlans = sourceTypes.map(createManualAccessPlan);
  const registry = evidenceStore.sources.map(createSourceRegistryEntry);
  const runs = [];
  const snapshots = [];
  return {
    manifest: {
      schema_version: EVIDENCE_PIPELINE_SCHEMA_VERSION,
      source_access_policy_version: SOURCE_ACCESS_POLICY_VERSION,
      evidence_target_version: EVIDENCE_PIPELINE_TARGET_VERSION,
      coverage_scope: evidenceStore.manifest.coverage_scope,
      generated_at: generatedAt,
      source_count: registry.length,
      access_plan_count: accessPlans.length,
      run_count: runs.length,
      snapshot_count: snapshots.length,
      external_collection_enabled: false,
      ai_is_factual_source: false,
    },
    registry,
    access_plans: accessPlans,
    runs,
    snapshots,
  };
}
