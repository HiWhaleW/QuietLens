import { assertContract } from "../contracts/validator.js";
import {
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_STORE_VERSION,
  EVIDENCE_ATTRIBUTES,
} from "../contracts/schemas.js";

const REQUIRED_IDENTITY_ATTRIBUTES = ["identity", "address", "coordinates"];

function duplicateIds(records, field) {
  const seen = new Set();
  const duplicates = new Set();
  for (const record of records) {
    if (seen.has(record[field])) duplicates.add(record[field]);
    seen.add(record[field]);
  }
  return [...duplicates];
}

function addIssue(issues, code, recordId, detail) {
  issues.push({ code, record_id: recordId, detail });
}

export function validateEvidenceStore(store) {
  const issues = [];
  const { manifest, places = [], sources = [], evidence = [] } = store ?? {};

  if (!manifest || typeof manifest !== "object") {
    addIssue(issues, "MANIFEST_MISSING", "store", "Evidence store manifest is required");
  } else {
    if (manifest.database_version !== "v0.1") {
      addIssue(issues, "DATABASE_VERSION_INVALID", "manifest", manifest.database_version);
    }
    if (manifest.evidence_store_version !== EVIDENCE_STORE_VERSION) {
      addIssue(issues, "STORE_VERSION_INVALID", "manifest", manifest.evidence_store_version);
    }
    if (manifest.contract_schema_version !== CONTRACT_SCHEMA_VERSION) {
      addIssue(issues, "CONTRACT_VERSION_INVALID", "manifest", manifest.contract_schema_version);
    }
    if (manifest.coverage_scope !== "huangpu-10-v0.1" || manifest.place_count !== 10) {
      addIssue(issues, "COVERAGE_SCOPE_INVALID", "manifest", "v0.1 must contain exactly the controlled Huangpu 10");
    }
    if (manifest.ai_is_factual_source !== false) {
      addIssue(issues, "AI_SOURCE_POLICY_INVALID", "manifest", "AI must never be a factual source");
    }
  }

  for (const [contract, records, idField] of [
    ["PlaceRecord", places, "place_id"],
    ["SourceRecord", sources, "source_id"],
    ["EvidenceRecord", evidence, "evidence_id"],
  ]) {
    for (const record of records) {
      try {
        assertContract(contract, record, record[idField] ?? contract);
      } catch (error) {
        addIssue(issues, "SCHEMA_INVALID", record[idField] ?? contract, error.message);
      }
    }
    for (const duplicate of duplicateIds(records, idField)) {
      addIssue(issues, "DUPLICATE_ID", duplicate, `${idField} must be unique`);
    }
  }

  if (places.length !== 10) {
    addIssue(issues, "PLACE_COUNT_INVALID", "store", `Expected 10 places, found ${places.length}`);
  }

  const placeById = new Map(places.map((place) => [place.place_id, place]));
  const sourceById = new Map(sources.map((source) => [source.source_id, source]));
  const evidenceById = new Map(evidence.map((record) => [record.evidence_id, record]));

  for (const place of places) {
    for (const sourceId of place.source_ids) {
      const source = sourceById.get(sourceId);
      if (!source) {
        addIssue(issues, "SOURCE_REFERENCE_MISSING", place.place_id, sourceId);
      } else if (!source.supports_place_ids.includes(place.place_id)) {
        addIssue(issues, "SOURCE_PLACE_MISMATCH", place.place_id, sourceId);
      }
    }

    const placeEvidence = evidence.filter((record) => record.place_id === place.place_id);
    for (const attribute of REQUIRED_IDENTITY_ATTRIBUTES) {
      if (!placeEvidence.some((record) => record.attribute === attribute && record.epistemic_status === "verified_fact")) {
        addIssue(issues, "IDENTITY_EVIDENCE_MISSING", place.place_id, attribute);
      }
    }
    for (const unknown of place.known_unknowns) {
      if (!placeEvidence.some(
        (record) => record.attribute === unknown.attribute && record.epistemic_status === "unknown",
      )) {
        addIssue(issues, "UNKNOWN_RECORD_MISSING", place.place_id, unknown.attribute);
      }
    }
  }

  for (const source of sources) {
    try {
      new URL(source.url);
    } catch {
      addIssue(issues, "SOURCE_URL_INVALID", source.source_id, source.url);
    }
    for (const placeId of source.supports_place_ids) {
      if (!placeById.has(placeId)) {
        addIssue(issues, "SOURCE_PLACE_REFERENCE_MISSING", source.source_id, placeId);
      }
    }
  }

  for (const record of evidence) {
    if (!placeById.has(record.place_id)) {
      addIssue(issues, "PLACE_REFERENCE_MISSING", record.evidence_id, record.place_id);
    }
    if (!EVIDENCE_ATTRIBUTES.includes(record.attribute)) {
      addIssue(issues, "ATTRIBUTE_UNKNOWN", record.evidence_id, record.attribute);
    }
    if (record.epistemic_status !== "unknown" && record.source_ids.length === 0) {
      addIssue(issues, "UNSUPPORTED_FACT", record.evidence_id, "Non-unknown evidence must cite a source");
    }
    if (record.epistemic_status === "editorial_estimate" && record.publishability !== "not_factual") {
      addIssue(issues, "ESTIMATE_MISREPRESENTED", record.evidence_id, record.publishability);
    }
    if (record.epistemic_status === "model_inference" && record.publishability !== "not_factual") {
      addIssue(issues, "MODEL_INFERENCE_MISREPRESENTED", record.evidence_id, record.publishability);
    }

    for (const sourceId of record.source_ids) {
      const source = sourceById.get(sourceId);
      if (!source) {
        addIssue(issues, "CITATION_MISSING", record.evidence_id, sourceId);
      } else if (!source.supports_place_ids.includes(record.place_id)) {
        addIssue(issues, "CITATION_PLACE_MISMATCH", record.evidence_id, sourceId);
      }
    }

    for (const conflictingId of record.conflicts_with) {
      const conflicting = evidenceById.get(conflictingId);
      if (!conflicting) {
        addIssue(issues, "CONFLICT_REFERENCE_MISSING", record.evidence_id, conflictingId);
        continue;
      }
      if (conflicting.place_id !== record.place_id || conflicting.attribute !== record.attribute) {
        addIssue(issues, "CONFLICT_SCOPE_MISMATCH", record.evidence_id, conflictingId);
      }
      if (!conflicting.conflicts_with.includes(record.evidence_id)) {
        addIssue(issues, "CONFLICT_NOT_SYMMETRIC", record.evidence_id, conflictingId);
      }
    }
  }

  const citedEvidence = evidence.filter((record) => record.epistemic_status !== "unknown");
  const citations = citedEvidence.flatMap((record) => record.source_ids);
  const existingCitations = citations.filter((sourceId) => sourceById.has(sourceId));
  const unsupportedFacts = issues.filter((issue) => issue.code === "UNSUPPORTED_FACT").length;

  return {
    valid: issues.length === 0,
    issues,
    metrics: {
      place_count: places.length,
      source_count: sources.length,
      evidence_count: evidence.length,
      schema_valid_record_count: places.length + sources.length + evidence.length
        - issues.filter((issue) => issue.code === "SCHEMA_INVALID").length,
      unsupported_fact_rate: citedEvidence.length === 0 ? 0 : unsupportedFacts / citedEvidence.length,
      citation_existence_rate: citations.length === 0 ? 1 : existingCitations.length / citations.length,
    },
  };
}

export function assertEvidenceStore(store) {
  const result = validateEvidenceStore(store);
  if (!result.valid) {
    throw new Error(result.issues.map((issue) => `${issue.code}:${issue.record_id}:${issue.detail}`).join("; "));
  }
  return result;
}
