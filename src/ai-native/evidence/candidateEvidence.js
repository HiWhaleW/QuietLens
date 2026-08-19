import { createHash } from "node:crypto";

import { assertCandidateContract, CANDIDATE_PIPELINE_SCHEMA_VERSION } from "./candidateContracts.js";

const HIGH_SEVERITY_CONFLICT_ATTRIBUTES = new Set([
  "identity",
  "address",
  "coordinates",
  "operating_status",
  "opening_hours",
]);

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all|any|previous|prior)\s+(?:instructions?|rules?)/iu,
  /system\s+prompt/iu,
  /environment\s+variables?/iu,
  /忽略.{0,12}(?:规则|指令|要求)/u,
  /(?:调用|使用).{0,12}(?:工具|tool)/iu,
  /(?:泄露|输出).{0,12}(?:提示词|密钥|环境变量)/u,
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizedCandidateValueKey(value) {
  return stableValue(value);
}

function normalizeName(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s·•._\-—–()（）[\]【】]/gu, "");
}

function aliasesForPlace(place) {
  return [place.canonical_name, ...place.aliases].map(normalizeName).filter(Boolean);
}

export function matchCandidatePlace(draft, source, places) {
  const supported = places.filter((place) => source.supports_place_ids.includes(place.place_id));
  const supportedIds = supported.map((place) => place.place_id);

  if (draft.place_id_hint) {
    if (supportedIds.includes(draft.place_id_hint)) {
      return {
        status: "matched",
        method: "exact_id",
        candidate_place_ids: [draft.place_id_hint],
        confidence: 1,
        requires_human_review: true,
      };
    }
    return {
      status: "unmatched",
      method: "none",
      candidate_place_ids: supportedIds,
      confidence: 0,
      requires_human_review: true,
    };
  }

  const hints = (draft.place_hints ?? []).map(normalizeName).filter(Boolean);
  const aliasMatches = supported.filter((place) => {
    const aliases = aliasesForPlace(place);
    return hints.some((hint) => aliases.includes(hint));
  });
  if (aliasMatches.length === 1) {
    return {
      status: "matched",
      method: "exact_alias",
      candidate_place_ids: [aliasMatches[0].place_id],
      confidence: 0.95,
      requires_human_review: true,
    };
  }
  if (aliasMatches.length > 1 || supported.length > 1) {
    return {
      status: "ambiguous",
      method: "none",
      candidate_place_ids: (aliasMatches.length ? aliasMatches : supported).map((place) => place.place_id),
      confidence: 0,
      requires_human_review: true,
    };
  }
  if (supported.length === 1 && draft.branch_context_confirmed === true) {
    return {
      status: "matched",
      method: "source_scope",
      candidate_place_ids: [supported[0].place_id],
      confidence: 0.85,
      requires_human_review: true,
    };
  }
  return {
    status: "unmatched",
    method: "none",
    candidate_place_ids: supportedIds,
    confidence: 0,
    requires_human_review: true,
  };
}

export function candidateContentFingerprint(candidateLike) {
  const candidatePlaceScope = [...(candidateLike.place_match?.candidate_place_ids ?? [])].sort().join(",");
  const placeScope = candidateLike.place_id ?? (candidatePlaceScope || "unmatched");
  return sha256([
    placeScope,
    candidateLike.attribute,
    stableValue(candidateLike.normalized_value),
    candidateLike.observed_at ?? "",
    candidateLike.applicable_time ?? "",
  ].join("|"));
}

function candidateId(draft, snapshot, fingerprint) {
  return `cand-${sha256(`${snapshot.snapshot_id}|${draft.attribute}|${fingerprint}|${draft.source_excerpt_untrusted}`).slice(0, 16)}`;
}

export function createCandidateEvidence(draft, pipelineState, evidenceStore) {
  if (draft.contains_personal_identifiers !== false) {
    throw new Error("CANDIDATE_PERSONAL_IDENTIFIERS_FORBIDDEN");
  }
  const snapshot = pipelineState.snapshots.find((item) => item.snapshot_id === draft.snapshot_id);
  if (!snapshot || snapshot.status !== "captured") throw new Error("CANDIDATE_CAPTURED_SNAPSHOT_REQUIRED");
  const source = evidenceStore.sources.find((item) => item.source_id === snapshot.source_id);
  const registry = pipelineState.registry.find((item) => item.source_id === snapshot.source_id);
  if (!source || !registry) throw new Error("CANDIDATE_REGISTERED_SOURCE_REQUIRED");
  if (!registry.permitted_attributes.includes(draft.attribute)) {
    throw new Error(`CANDIDATE_ATTRIBUTE_NOT_PERMITTED:${draft.attribute}`);
  }

  const placeMatch = matchCandidatePlace(draft, source, evidenceStore.places);
  const placeId = placeMatch.status === "matched" ? placeMatch.candidate_place_ids[0] : null;
  const riskFlags = new Set();
  if (draft.extraction_method === "ai_assisted") riskFlags.add("ai_extracted");
  if (source.source_type === "traceable_ugc") riskFlags.add("traceable_ugc");
  if (placeMatch.status === "ambiguous") riskFlags.add("identity_ambiguous");
  if (placeMatch.status === "unmatched") riskFlags.add("place_unmatched");
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(draft.source_excerpt_untrusted))) {
    riskFlags.add("prompt_injection_text");
  }

  const candidateBase = {
    schema_version: CANDIDATE_PIPELINE_SCHEMA_VERSION,
    snapshot_id: snapshot.snapshot_id,
    source_id: source.source_id,
    source_type: source.source_type,
    place_id: placeId,
    place_match: placeMatch,
    attribute: draft.attribute,
    source_excerpt_untrusted: draft.source_excerpt_untrusted,
    normalized_value: draft.normalized_value,
    observed_at: draft.observed_at ?? null,
    published_at: draft.published_at ?? null,
    applicable_time: draft.applicable_time ?? null,
    extraction_method: draft.extraction_method,
    extraction_model: draft.extraction_method === "ai_assisted" ? draft.extraction_model : null,
    status: "candidate",
    review_status: "pending",
    risk_flags: [...riskFlags].sort(),
    contains_personal_identifiers: false,
    ai_is_factual_source: false,
  };
  const contentFingerprint = candidateContentFingerprint(candidateBase);
  const candidate = {
    ...candidateBase,
    candidate_id: candidateId(draft, snapshot, contentFingerprint),
    content_fingerprint: contentFingerprint,
  };
  return assertCandidateContract("CandidateEvidenceRecord", candidate, candidate.candidate_id);
}

export function buildDeduplicationClusters(candidates) {
  const byFingerprint = new Map();
  for (const candidate of candidates) {
    const group = byFingerprint.get(candidate.content_fingerprint) ?? [];
    group.push(candidate);
    byFingerprint.set(candidate.content_fingerprint, group);
  }
  return [...byFingerprint.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([fingerprint, group]) => {
      const candidateIds = group.map((candidate) => candidate.candidate_id).sort();
      const cluster = {
        schema_version: CANDIDATE_PIPELINE_SCHEMA_VERSION,
        cluster_id: `dedup-${sha256(candidateIds.join("|")).slice(0, 16)}`,
        content_fingerprint: fingerprint,
        candidate_ids: candidateIds,
        source_ids: [...new Set(group.map((candidate) => candidate.source_id))].sort(),
        place_id: group[0].place_id,
        attribute: group[0].attribute,
        status: "duplicate_cluster",
        review_status: "pending",
        requires_human_review: true,
      };
      return assertCandidateContract("DeduplicationCluster", cluster, cluster.cluster_id);
    });
}

export function buildConflictQueue(candidates) {
  const comparable = candidates.filter((candidate) => candidate.place_id && candidate.place_match.status === "matched");
  const groups = new Map();
  for (const candidate of comparable) {
    const key = `${candidate.place_id}|${candidate.attribute}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const conflicts = [];
  for (const group of groups.values()) {
    const normalizedValues = new Set(group.map((candidate) => normalizedCandidateValueKey(candidate.normalized_value)));
    if (normalizedValues.size < 2) continue;
    const candidateIds = group.map((candidate) => candidate.candidate_id).sort();
    const timeScopes = new Set(group.map((candidate) => candidate.applicable_time ?? ""));
    const conflict = {
      schema_version: CANDIDATE_PIPELINE_SCHEMA_VERSION,
      conflict_id: `conflict-${sha256(candidateIds.join("|")).slice(0, 16)}`,
      place_id: group[0].place_id,
      attribute: group[0].attribute,
      candidate_ids: candidateIds,
      reason: "normalized_value_disagreement",
      severity: HIGH_SEVERITY_CONFLICT_ATTRIBUTES.has(group[0].attribute) ? "high" : "medium",
      comparison_scope: timeScopes.size === 1 ? "same_time_scope" : "time_scope_review",
      status: "pending_review",
      requires_human_review: true,
    };
    conflicts.push(assertCandidateContract("ConflictQueueItem", conflict, conflict.conflict_id));
  }
  return conflicts;
}
