import { filterPlacesByHardConstraints } from "./hardConstraintFilter.js";
import { EXPLORATION_SCORE_VERSION, scoreExplorationPlaces } from "./explorationScore.js";
import { assertEvidenceStore } from "./validateStore.js";

const CORE_ATTRIBUTES = ["identity", "address", "coordinates", "operating_status", "opening_hours"];
const TASK_ATTRIBUTES = {
  focus: ["workspace", "noise", "crowding", "daylight", "seating", "outlets"],
  recovery: ["noise", "crowding", "daylight", "outdoor_seating", "seating"],
  conversation: ["noise", "crowding", "seating", "outdoor_seating"],
  call: ["call_environment", "noise", "crowding", "outlets"],
  other: ["noise", "crowding", "daylight", "seating"],
};

const HUANGPU_AREA_MARKERS = [
  "黄浦",
  "外滩",
  "人民广场",
  "南京东路",
  "淮海",
  "新天地",
  "老西门",
  "豫园",
  "打浦桥",
  "上海全域",
];

function requestedAttributes(request) {
  return [...new Set([
    ...CORE_ATTRIBUTES,
    ...(TASK_ATTRIBUTES[request.task.type] ?? TASK_ATTRIBUTES.other),
    ...request.hard_constraints.map((constraint) => constraint.field),
    ...request.soft_preferences.map((preference) => preference.field),
    ...request.unknowns.filter((field) => typeof field === "string"),
  ])];
}

function evidenceRank(record, requested, explicit) {
  let score = requested.has(record.attribute) ? 100 : 0;
  if (explicit.has(record.attribute)) score += 100;
  if (record.conflict_status !== "none") score += 25;
  if (record.epistemic_status === "unknown") score += 18;
  if (record.freshness === "current") score += 12;
  if (record.reliability === "high") score += 8;
  if (record.verification_status === "cross_checked") score += 5;
  return score;
}

function publicPlace(place) {
  return {
    place_id: place.place_id,
    canonical_name: place.canonical_name,
    address: place.address.primary,
    location: place.location,
    asset: place.asset.status === "confirmed" && place.asset.path
      ? `/${place.asset.path.replace(/^public\//, "")}`
      : null,
  };
}

export function isAreaWithinScope(area) {
  if (typeof area !== "string" || !area.trim()) return false;
  return HUANGPU_AREA_MARKERS.some((marker) => area.includes(marker));
}

export function retrieveEvidence(request, store, { maxEvidencePerPlace = 8 } = {}) {
  assertEvidenceStore(store);
  if (!isAreaWithinScope(request.location.area)) {
    return {
      status: "out_of_scope",
      coverage_scope: store.manifest.coverage_scope,
      requested_area: request.location.area,
      candidates: [],
      rejected: [],
    };
  }

  const filter = filterPlacesByHardConstraints(request, store.places, store.evidence);
  const bucketByPlace = new Map([
    ...filter.eligible.map((entry) => [entry.place_id, { eligibility: "eligible", entry }]),
    ...filter.uncertain.map((entry) => [entry.place_id, { eligibility: "uncertain", entry }]),
  ]);
  const attributes = requestedAttributes(request);
  const requested = new Set(attributes);
  const explicit = new Set([
    ...request.hard_constraints.map((constraint) => constraint.field),
    ...request.soft_preferences.map((preference) => preference.field),
    ...request.unknowns.filter((field) => typeof field === "string"),
  ]);
  const candidates = store.places
    .filter((place) => bucketByPlace.has(place.place_id))
    .map((place) => {
      const { eligibility, entry } = bucketByPlace.get(place.place_id);
      const evidence = store.evidence
        .filter((record) => record.place_id === place.place_id && requested.has(record.attribute))
        .sort((a, b) => evidenceRank(b, requested, explicit) - evidenceRank(a, requested, explicit)
          || a.evidence_id.localeCompare(b.evidence_id))
        .slice(0, maxEvidencePerPlace);
      return {
        place: publicPlace(place),
        eligibility,
        hard_constraint_results: entry.results,
        evidence,
      };
    });

  return {
    status: candidates.length === 0 ? "no_candidates" : "ready",
    coverage_scope: store.manifest.coverage_scope,
    requested_attributes: attributes,
    candidates,
    rejected: filter.rejected,
  };
}

export function buildPublicDecisionContext(brief, store, retrieval = null) {
  const explorationPlaces = retrieval ? scoreExplorationPlaces(brief.request, retrieval, store) : [];
  const evidenceIds = new Set(brief.candidates.flatMap((candidate) => [
    ...candidate.fit_reasons.flatMap((reason) => reason.evidence_ids),
    ...candidate.tradeoffs.flatMap((reason) => reason.evidence_ids),
    ...candidate.hard_constraint_results.flatMap((result) => result.evidence_ids),
  ]));
  explorationPlaces.flatMap((place) => place.evidence_ids).forEach((evidenceId) => evidenceIds.add(evidenceId));
  const sourceIds = new Set(
    store.evidence
      .filter((record) => evidenceIds.has(record.evidence_id))
      .flatMap((record) => record.source_ids),
  );

  return {
    places: store.places.map(publicPlace),
    exploration: {
      score_version: EXPLORATION_SCORE_VERSION,
      places: explorationPlaces,
    },
    evidence: store.evidence
      .filter((record) => evidenceIds.has(record.evidence_id))
      .map((record) => ({
        evidence_id: record.evidence_id,
        place_id: record.place_id,
        attribute: record.attribute,
        claim_text: record.claim_text,
        verified_at: record.verified_at,
        freshness: record.freshness,
        reliability: record.reliability,
        conflict_status: record.conflict_status,
        source_ids: record.source_ids,
      })),
    sources: store.sources
      .filter((source) => sourceIds.has(source.source_id))
      .map((source) => ({
        source_id: source.source_id,
        source_type: source.source_type,
        publisher: source.publisher,
        title: source.title,
        url: source.url.startsWith("http") ? source.url : null,
        published_at: source.published_at,
        accessed_at: source.accessed_at,
      })),
  };
}
