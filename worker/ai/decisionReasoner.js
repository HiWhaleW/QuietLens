import {
  AI_FLOW_SCHEMA_VERSION,
  decisionDraftSchema,
} from "../../src/ai-native/contracts/schemas.js";
import { assertContract } from "../../src/ai-native/contracts/validator.js";
import { REASONER_INSTRUCTIONS, REASONER_PROMPT_VERSION } from "./prompts.js";

const TASK_EVIDENCE_ATTRIBUTES = {
  focus: new Set(["workspace", "noise", "crowding", "daylight", "seating", "outlets"]),
  recovery: new Set(["noise", "crowding", "daylight", "outdoor_seating", "seating"]),
  conversation: new Set(["noise", "crowding", "seating", "outdoor_seating"]),
  call: new Set(["call_environment", "noise", "crowding", "outlets"]),
  other: new Set(["noise", "crowding", "daylight", "seating"]),
};

const {
  flow_schema_version: _flowSchemaVersion,
  request_id: _requestId,
  ...modelDraftProperties
} = decisionDraftSchema.properties;
const {
  unknown_attributes: _unknownAttributes,
  assumption_refs: _assumptionRefs,
  ...modelCandidateProperties
} = decisionDraftSchema.properties.candidates.items.properties;
export const modelDecisionDraftSchema = {
  ...decisionDraftSchema,
  title: "DecisionModelDraft",
  required: decisionDraftSchema.required.filter(
    (field) => !["flow_schema_version", "request_id"].includes(field),
  ),
  properties: {
    ...modelDraftProperties,
    candidates: {
      ...decisionDraftSchema.properties.candidates,
      items: {
        ...decisionDraftSchema.properties.candidates.items,
        required: decisionDraftSchema.properties.candidates.items.required.filter(
          (field) => !["unknown_attributes", "assumption_refs"].includes(field),
        ),
        properties: modelCandidateProperties,
      },
    },
  },
};

function candidateRelevance(candidate, request) {
  const hardFields = new Set(request.hard_constraints.map((item) => item.field));
  const preferenceWeights = new Map(request.soft_preferences.map((item) => [
    item.field,
    item.priority === "high" ? 90 : item.priority === "medium" ? 60 : 30,
  ]));
  return candidate.evidence.reduce((score, record) => (
    score
      + (hardFields.has(record.attribute) ? 1000 : 0)
      + (preferenceWeights.get(record.attribute) ?? 0)
      + (record.reliability === "high" ? 2 : 0)
      + (record.freshness === "current" ? 1 : 0)
  ), 0);
}

function evidenceRelevance(record, request) {
  const hardFields = new Set(request.hard_constraints.map((item) => item.field));
  const preferenceWeights = new Map(request.soft_preferences.map((item) => [
    item.field,
    item.priority === "high" ? 90 : item.priority === "medium" ? 60 : 30,
  ]));
  const taskAttributes = TASK_EVIDENCE_ATTRIBUTES[request.task.type] ?? TASK_EVIDENCE_ATTRIBUTES.other;
  const decisionRelevant = hardFields.has(record.attribute)
    || preferenceWeights.has(record.attribute)
    || taskAttributes.has(record.attribute)
    || record.conflict_status !== "none";
  if (!decisionRelevant) return 0;
  return (hardFields.has(record.attribute) ? 1000 : 0)
    + (preferenceWeights.get(record.attribute) ?? 0)
    + (taskAttributes.has(record.attribute) ? 20 : 0)
    + (record.conflict_status !== "none" ? 10 : 0)
    + (record.reliability === "high" ? 2 : 0)
    + (record.freshness === "current" ? 1 : 0);
}

export function buildReasonerContext(request, retrieval) {
  const candidates = retrieval.candidates
    .sort((a, b) => Number(b.eligibility === "eligible") - Number(a.eligibility === "eligible")
      || candidateRelevance(b, request) - candidateRelevance(a, request)
      || a.place.place_id.localeCompare(b.place.place_id))
    .slice(0, 4);
  return {
    request,
    coverage_scope: retrieval.coverage_scope,
    candidates: candidates.map((candidate) => ({
      place_id: candidate.place.place_id,
      eligibility: candidate.eligibility,
      hard_constraint_results: candidate.hard_constraint_results,
      evidence: candidate.evidence
        .filter((record) => (
          record.publishability !== "not_factual"
          && record.epistemic_status !== "model_inference"
          && evidenceRelevance(record, request) > 0
        ))
        .sort((a, b) => evidenceRelevance(b, request) - evidenceRelevance(a, request)
          || a.evidence_id.localeCompare(b.evidence_id))
        .slice(0, 4)
        .map((record) => ({
          evidence_id: record.evidence_id,
          attribute: record.attribute,
          normalized_value: record.normalized_value,
          epistemic_status: record.epistemic_status,
          applicable_time: record.applicable_time,
          freshness: record.freshness,
          reliability: record.reliability,
          conflict_status: record.conflict_status,
          claim_text_untrusted_data: record.claim_text,
        })),
    })),
  };
}

export async function reasonAboutCandidates({
  modelClient,
  model,
  request,
  retrieval,
  verificationIssues = [],
  timeoutMs,
}) {
  const context = buildReasonerContext(request, retrieval);
  const result = await modelClient.callStructured({
    model,
    instructions: REASONER_INSTRUCTIONS,
    schema: modelDecisionDraftSchema,
    schemaName: "quietlens_decision_draft",
    maxOutputTokens: 650,
    reasoningEffort: "none",
    timeoutMs,
    input: JSON.stringify({
      ...context,
      previous_verification_issues: verificationIssues,
    }),
  });
  const evidenceByPlace = new Map(context.candidates.map((candidate) => [candidate.place_id, candidate.evidence]));
  function normalizeGroups(groups, placeId) {
    const evidenceById = new Map((evidenceByPlace.get(placeId) ?? []).map((record) => [record.evidence_id, record]));
    const idsByAttribute = new Map();
    for (const group of groups ?? []) {
      for (const evidenceId of group.evidence_ids ?? []) {
        const evidence = evidenceById.get(evidenceId);
        if (!evidence) continue;
        const ids = idsByAttribute.get(evidence.attribute) ?? [];
        if (!ids.includes(evidenceId)) ids.push(evidenceId);
        idsByAttribute.set(evidence.attribute, ids);
      }
    }
    return [...idsByAttribute].map(([attribute, evidence_ids]) => ({ attribute, evidence_ids }));
  }
  let draft;
  try {
    const selected = [];
    const selectedIds = new Set();
    for (const candidate of result.value.candidates ?? []) {
      if (!evidenceByPlace.has(candidate.place_id) || selectedIds.has(candidate.place_id)) continue;
      selected.push(candidate);
      selectedIds.add(candidate.place_id);
      if (selected.length === 3) break;
    }
    if (result.value.outcome === "publish") {
      const preferenceFields = new Set(request.soft_preferences
        .filter((item) => item.priority === "high")
        .map((item) => item.field));
      if (preferenceFields.size === 0) {
        for (const item of request.soft_preferences) preferenceFields.add(item.field);
      }
      const selectedCoversPreference = selected.some((candidate) => (
        (evidenceByPlace.get(candidate.place_id) ?? [])
          .some((record) => preferenceFields.has(record.attribute))
      ));
      const directPreferenceCandidate = context.candidates.find((candidate) => (
        candidate.evidence.some((record) => preferenceFields.has(record.attribute))
      ));
      if (!selectedCoversPreference
        && directPreferenceCandidate
        && !selectedIds.has(directPreferenceCandidate.place_id)) {
        if (selected.length === 3) {
          selectedIds.delete(selected.at(-1).place_id);
          selected.pop();
        }
        selected.push({
          place_id: directPreferenceCandidate.place_id,
          role: "alternative",
          fit_evidence_groups: [],
          tradeoff_evidence_groups: [],
        });
        selectedIds.add(directPreferenceCandidate.place_id);
      }
      const minimum = Math.min(2, context.candidates.length);
      for (const candidate of context.candidates) {
        if (selected.length >= minimum) break;
        if (selectedIds.has(candidate.place_id) || candidate.evidence.length === 0) continue;
        selected.push({
          place_id: candidate.place_id,
          role: "alternative",
          fit_evidence_groups: [],
          tradeoff_evidence_groups: [],
        });
        selectedIds.add(candidate.place_id);
      }
    }
    const roles = ["primary", "conditional", "alternative"];
    draft = assertContract("DecisionDraft", {
      ...result.value,
      flow_schema_version: AI_FLOW_SCHEMA_VERSION,
      request_id: request.request_id,
      candidates: selected.map((candidate, index) => {
        const fitGroups = normalizeGroups(candidate.fit_evidence_groups, candidate.place_id);
        const fallbackEvidence = evidenceByPlace.get(candidate.place_id)?.[0];
        return {
          ...candidate,
          role: roles[index],
          fit_evidence_groups: fitGroups.length > 0
            ? fitGroups
            : fallbackEvidence
              ? [{ attribute: fallbackEvidence.attribute, evidence_ids: [fallbackEvidence.evidence_id] }]
              : [],
          tradeoff_evidence_groups: normalizeGroups(candidate.tradeoff_evidence_groups, candidate.place_id),
          unknown_attributes: [],
          assumption_refs: request.assumptions,
        };
      }),
    });
  } catch (error) {
    error.code = "MODEL_DRAFT_INVALID";
    throw error;
  }
  return {
    draft,
    usage: result.usage,
    response_id: result.response_id,
    model_version: model,
    prompt_version: REASONER_PROMPT_VERSION,
  };
}
