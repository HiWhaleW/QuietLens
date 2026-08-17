export const CONTRACT_SCHEMA_VERSION = "1.0.0";
export const EVIDENCE_STORE_VERSION = "0.1.0";
export const EVALUATION_SET_VERSION = "0.1.5";
export const EVENT_SCHEMA_VERSION = "1.0.0";
export const AI_FLOW_SCHEMA_VERSION = "0.1.0";

export const PLACE_ID_PATTERN = "^hp-[a-z0-9]+(?:-[a-z0-9]+)*$";
export const SOURCE_ID_PATTERN = "^src-[a-z0-9]+(?:-[a-z0-9]+)*$";
export const EVIDENCE_ID_PATTERN = "^ev-[a-z0-9]+(?:-[a-z0-9]+)*$";

export const EVIDENCE_ATTRIBUTES = [
  "identity",
  "address",
  "coordinates",
  "operating_status",
  "opening_hours",
  "facade",
  "interior",
  "size",
  "workspace",
  "daylight",
  "seating",
  "outlets",
  "outdoor_seating",
  "noise",
  "crowding",
  "peak_time",
  "call_environment",
  "walk_time",
  "realtime_seats",
  "realtime_noise",
];

const nullableDate = { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}(?:T.*)?$" };
const versionField = { const: CONTRACT_SCHEMA_VERSION };
const stringArray = { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true };
const evidenceIdArray = {
  type: "array",
  items: { type: "string", pattern: EVIDENCE_ID_PATTERN },
  uniqueItems: true,
};

export const placeRecordSchema = {
  $id: "https://quietlens.local/schema/place-record-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "PlaceRecord",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "place_id",
    "canonical_name",
    "aliases",
    "coverage_scope",
    "identity_status",
    "address",
    "location",
    "source_ids",
    "known_unknowns",
    "asset",
  ],
  properties: {
    schema_version: versionField,
    place_id: { type: "string", pattern: PLACE_ID_PATTERN },
    canonical_name: { type: "string", minLength: 1 },
    aliases: stringArray,
    coverage_scope: { const: "huangpu-10-v0.1" },
    identity_status: { enum: ["verified", "partial", "unverified", "closed"] },
    address: {
      type: "object",
      additionalProperties: false,
      required: ["primary", "variants", "conflict_status"],
      properties: {
        primary: { type: "string", minLength: 1 },
        variants: stringArray,
        conflict_status: { enum: ["none", "documented", "unresolved"] },
      },
    },
    location: {
      type: "object",
      additionalProperties: false,
      required: ["coordinate_system", "latitude", "longitude", "verified_at"],
      properties: {
        coordinate_system: { const: "WGS84" },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        verified_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      },
    },
    source_ids: {
      type: "array",
      minItems: 1,
      items: { type: "string", pattern: SOURCE_ID_PATTERN },
      uniqueItems: true,
    },
    known_unknowns: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["attribute", "reason"],
        properties: {
          attribute: { enum: EVIDENCE_ATTRIBUTES },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
    asset: {
      type: "object",
      additionalProperties: false,
      required: ["status", "path"],
      properties: {
        status: { enum: ["confirmed", "pending"] },
        path: { type: ["string", "null"], minLength: 1 },
      },
    },
  },
};

export const sourceRecordSchema = {
  $id: "https://quietlens.local/schema/source-record-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "SourceRecord",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "source_id",
    "source_type",
    "publisher",
    "author",
    "title",
    "url",
    "published_at",
    "accessed_at",
    "reliability",
    "usage_restrictions",
    "supports_place_ids",
  ],
  properties: {
    schema_version: versionField,
    source_id: { type: "string", pattern: SOURCE_ID_PATTERN },
    source_type: {
      enum: [
        "map_listing",
        "signed_reporting",
        "brand_interview",
        "editorial_guide",
        "traceable_ugc",
        "official_page",
        "address_reference",
        "curated_registry",
      ],
    },
    publisher: { type: "string", minLength: 1 },
    author: { type: ["string", "null"], minLength: 1 },
    title: { type: "string", minLength: 1 },
    url: { type: "string", pattern: "^(?:https?://|urn:quietlens:)" },
    published_at: nullableDate,
    accessed_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    reliability: { enum: ["high", "medium", "low"] },
    usage_restrictions: { enum: ["citation_only", "research_only", "public_reference"] },
    supports_place_ids: {
      type: "array",
      minItems: 1,
      items: { type: "string", pattern: PLACE_ID_PATTERN },
      uniqueItems: true,
    },
  },
};

export const evidenceRecordSchema = {
  $id: "https://quietlens.local/schema/evidence-record-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvidenceRecord",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "evidence_id",
    "place_id",
    "attribute",
    "claim_text",
    "normalized_value",
    "constraint_usable",
    "epistemic_status",
    "source_ids",
    "observed_at",
    "published_at",
    "verified_at",
    "applicable_time",
    "verification_status",
    "freshness",
    "reliability",
    "conflicts_with",
    "conflict_status",
    "publishability",
    "unknown_reason",
  ],
  properties: {
    schema_version: versionField,
    evidence_id: { type: "string", pattern: EVIDENCE_ID_PATTERN },
    place_id: { type: "string", pattern: PLACE_ID_PATTERN },
    attribute: { enum: EVIDENCE_ATTRIBUTES },
    claim_text: { type: "string", minLength: 1 },
    normalized_value: { type: ["string", "number", "boolean", "array", "null"] },
    constraint_usable: { type: "boolean" },
    epistemic_status: {
      enum: ["verified_fact", "sourced_observation", "editorial_estimate", "model_inference", "unknown"],
    },
    source_ids: {
      type: "array",
      items: { type: "string", pattern: SOURCE_ID_PATTERN },
      uniqueItems: true,
    },
    observed_at: nullableDate,
    published_at: nullableDate,
    verified_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    applicable_time: { type: ["string", "null"], minLength: 1 },
    verification_status: { enum: ["cross_checked", "single_source", "candidate", "unverified"] },
    freshness: { enum: ["current", "aging", "stale", "unknown"] },
    reliability: { enum: ["high", "medium", "low", "unknown"] },
    conflicts_with: evidenceIdArray,
    conflict_status: { enum: ["none", "documented", "unresolved", "resolved"] },
    publishability: { enum: ["factual", "qualified", "not_factual"] },
    unknown_reason: { type: ["string", "null"], minLength: 1 },
  },
  allOf: [
    {
      if: { properties: { epistemic_status: { const: "unknown" } } },
      then: {
        properties: {
          source_ids: { type: "array", maxItems: 0 },
          normalized_value: { type: "null" },
          constraint_usable: { const: false },
          publishability: { const: "not_factual" },
          unknown_reason: { type: "string", minLength: 1 },
        },
      },
      else: { properties: { source_ids: { type: "array", minItems: 1 } } },
    },
    {
      if: { properties: { epistemic_status: { const: "model_inference" } } },
      then: { properties: { publishability: { const: "not_factual" } } },
    },
  ],
};

const constraintSchema = {
  type: "object",
  additionalProperties: false,
  required: ["constraint_id", "field", "operator", "value"],
  properties: {
    constraint_id: { type: "string", pattern: "^hc-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    field: { enum: EVIDENCE_ATTRIBUTES },
    operator: { enum: ["equals", "supports", "at_least", "at_most", "available", "not_equals"] },
    value: { type: ["string", "number", "boolean", "array"] },
  },
};

export const decisionRequestSchema = {
  $id: "https://quietlens.local/schema/decision-request-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "DecisionRequest",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "request_id",
    "evidence_store_version",
    "task",
    "time",
    "location",
    "hard_constraints",
    "soft_preferences",
    "unknowns",
    "assumptions",
    "confirmed_by_user",
  ],
  properties: {
    schema_version: versionField,
    request_id: { type: "string", pattern: "^req-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    evidence_store_version: { const: EVIDENCE_STORE_VERSION },
    task: {
      type: "object",
      additionalProperties: false,
      required: ["type", "duration_minutes"],
      properties: {
        type: { enum: ["focus", "recovery", "conversation", "call", "other"] },
        duration_minutes: { type: ["integer", "null"], minimum: 1, maximum: 480 },
      },
    },
    time: {
      type: "object",
      additionalProperties: false,
      required: ["arrival_at", "hard_leave_at", "original_phrase"],
      properties: {
        arrival_at: nullableDate,
        hard_leave_at: nullableDate,
        original_phrase: { type: ["string", "null"] },
      },
    },
    location: {
      type: "object",
      additionalProperties: false,
      required: ["area", "max_walk_minutes"],
      properties: {
        area: { type: "string", minLength: 1 },
        max_walk_minutes: { type: ["integer", "null"], minimum: 1, maximum: 90 },
      },
    },
    hard_constraints: { type: "array", items: constraintSchema },
    soft_preferences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "priority"],
        properties: {
          field: { enum: EVIDENCE_ATTRIBUTES },
          priority: { enum: ["low", "medium", "high"] },
        },
      },
    },
    unknowns: stringArray,
    assumptions: stringArray,
    confirmed_by_user: { type: "boolean" },
  },
};

const groundedReasonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "evidence_ids"],
  properties: {
    text: { type: "string", minLength: 1 },
    evidence_ids: { ...evidenceIdArray, minItems: 1 },
  },
};

export const decisionCandidateSchema = {
  $id: "https://quietlens.local/schema/decision-candidate-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "DecisionCandidate",
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "request_id",
    "place_id",
    "role",
    "hard_constraint_results",
    "fit_reasons",
    "tradeoffs",
    "unknowns",
    "confidence",
    "assumptions",
  ],
  properties: {
    schema_version: versionField,
    request_id: { type: "string", pattern: "^req-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    place_id: { type: "string", pattern: PLACE_ID_PATTERN },
    role: { enum: ["primary", "conditional", "alternative"] },
    hard_constraint_results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["constraint_id", "status", "evidence_ids", "reason_code"],
        properties: {
          constraint_id: { type: "string", pattern: "^hc-[a-z0-9]+(?:-[a-z0-9]+)*$" },
          status: { enum: ["pass", "fail", "unknown"] },
          evidence_ids: evidenceIdArray,
          reason_code: { type: "string", pattern: "^[a-z0-9_]+$" },
        },
      },
    },
    fit_reasons: { type: "array", items: groundedReasonSchema },
    tradeoffs: { type: "array", items: groundedReasonSchema },
    unknowns: stringArray,
    confidence: {
      type: "object",
      additionalProperties: false,
      required: ["level", "basis"],
      properties: {
        level: { enum: ["high", "medium", "low"] },
        basis: stringArray,
      },
    },
    assumptions: stringArray,
  },
};

export const evaluationCaseSchema = {
  $id: "https://quietlens.local/schema/evaluation-case-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "EvaluationCase",
  type: "object",
  additionalProperties: false,
  required: [
    "eval_schema_version",
    "case_id",
    "evidence_store_version",
    "subset",
    "tags",
    "messages",
    "now",
    "structured_request",
    "gold",
  ],
  properties: {
    eval_schema_version: { const: EVALUATION_SET_VERSION },
    case_id: { type: "string", pattern: "^ql-eval-\\d{3}$" },
    evidence_store_version: { const: EVIDENCE_STORE_VERSION },
    subset: {
      enum: [
        "standard",
        "ambiguous",
        "clarification",
        "conflict_or_no_result",
        "insufficient_or_out_of_scope",
        "correction",
        "safety",
      ],
    },
    tags: { ...stringArray, minItems: 3 },
    messages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "content"],
        properties: {
          role: { enum: ["user", "assistant"] },
          content: { type: "string", minLength: 1 },
        },
      },
    },
    now: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T" },
    structured_request: { type: "object" },
    gold: {
      type: "object",
      additionalProperties: false,
      required: [
        "intent",
        "correction",
        "clarification",
        "expected_behavior",
        "acceptable_candidates",
        "forbidden_candidates",
        "required_evidence_attributes",
        "must_disclose_unknowns",
        "expected_hard_constraint_statuses",
      ],
      properties: {
        intent: {
          type: "object",
          additionalProperties: false,
          required: ["required_fields"],
          properties: {
            required_fields: {
              type: "array",
              items: {
                enum: [
                  "task_type",
                  "duration_minutes",
                  "arrival_at",
                  "hard_leave_at",
                  "location_area",
                  "max_walk_minutes",
                  "hard_constraints",
                  "soft_preferences",
                  "unknowns",
                ],
              },
              uniqueItems: true,
            },
          },
        },
        correction: {
          type: "object",
          additionalProperties: false,
          required: ["target_fields"],
          properties: {
            target_fields: {
              type: "array",
              items: {
                enum: [
                  "task_type",
                  "duration_minutes",
                  "arrival_at",
                  "hard_leave_at",
                  "location_area",
                  "max_walk_minutes",
                  "hard_constraints",
                  "soft_preferences",
                ],
              },
              uniqueItems: true,
            },
          },
        },
        clarification: {
          type: "object",
          additionalProperties: false,
          required: ["required", "acceptable_target_fields"],
          properties: {
            required: { type: "boolean" },
            acceptable_target_fields: { type: "array", items: { enum: EVIDENCE_ATTRIBUTES }, uniqueItems: true },
          },
        },
        expected_behavior: {
          enum: ["clarify", "recommend", "cautious_recommend", "request_relaxation", "refuse", "block_untrusted_instruction"],
        },
        acceptable_candidates: {
          type: "array",
          items: { type: "string", pattern: PLACE_ID_PATTERN },
          uniqueItems: true,
        },
        forbidden_candidates: {
          type: "array",
          items: { type: "string", pattern: PLACE_ID_PATTERN },
          uniqueItems: true,
        },
        required_evidence_attributes: { type: "array", items: { enum: EVIDENCE_ATTRIBUTES }, uniqueItems: true },
        must_disclose_unknowns: stringArray,
        expected_hard_constraint_statuses: {
          type: "object",
          additionalProperties: {
            type: "object",
            additionalProperties: { enum: ["pass", "fail", "unknown"] },
          },
        },
      },
    },
  },
};

export const analyticsEventSchema = {
  $id: "https://quietlens.local/schema/analytics-event-v1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "AnalyticsEvent",
  type: "object",
  additionalProperties: false,
  required: [
    "event_name",
    "event_schema_version",
    "session_id",
    "request_id",
    "experience_stage",
    "model_version",
    "prompt_version",
    "contract_schema_version",
    "evidence_store_version",
    "client_at",
    "server_at",
    "error_code",
    "properties",
  ],
  properties: {
    event_name: { type: "string", pattern: "^[a-z0-9_]+$" },
    event_schema_version: { const: EVENT_SCHEMA_VERSION },
    session_id: { type: "string", pattern: "^sess-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    request_id: { type: "string", pattern: "^req-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    experience_stage: { enum: ["F0", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "system"] },
    model_version: { type: "string", minLength: 1 },
    prompt_version: { type: "string", minLength: 1 },
    contract_schema_version: { const: CONTRACT_SCHEMA_VERSION },
    evidence_store_version: { const: EVIDENCE_STORE_VERSION },
    client_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T" },
    server_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T" },
    error_code: { type: ["string", "null"], pattern: "^[A-Z0-9_]+$" },
    properties: { type: "object" },
  },
};

const patchConfidence = { enum: ["high", "medium", "low"] };
const patchAction = { enum: ["keep", "set", "clear"] };

function scalarPatchSchema(valueSchema) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "value", "confidence"],
    properties: {
      action: patchAction,
      value: valueSchema,
      confidence: patchConfidence,
    },
  };
}

const patchConstraintSchema = {
  type: "object",
  additionalProperties: false,
  required: ["field", "operator", "value"],
  properties: {
    field: { enum: EVIDENCE_ATTRIBUTES },
    operator: { enum: ["equals", "supports", "at_least", "at_most", "available", "not_equals"] },
    value: { type: "string" },
  },
};

const patchPreferenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["field", "priority"],
  properties: {
    field: { enum: EVIDENCE_ATTRIBUTES },
    priority: { enum: ["low", "medium", "high"] },
  },
};

function arrayPatchSchema(itemSchema) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "value", "confidence"],
    properties: {
      action: { enum: ["keep", "replace", "clear"] },
      value: { type: "array", items: itemSchema },
      confidence: patchConfidence,
    },
  };
}

export const decisionRequestPatchSchema = {
  $id: "https://quietlens.local/schema/decision-request-patch-v0.1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "DecisionRequestPatch",
  type: "object",
  additionalProperties: false,
  required: [
    "flow_schema_version",
    "request_id",
    "mode",
    "task_type",
    "duration_minutes",
    "arrival_at",
    "hard_leave_at",
    "time_original_phrase",
    "location_area",
    "max_walk_minutes",
    "hard_constraints",
    "soft_preferences",
    "unknowns",
    "assumptions",
  ],
  properties: {
    flow_schema_version: { const: AI_FLOW_SCHEMA_VERSION },
    request_id: { type: "string", pattern: "^req-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    mode: { enum: ["initial", "correction"] },
    task_type: scalarPatchSchema({ enum: [null, "focus", "recovery", "conversation", "call", "other"] }),
    duration_minutes: scalarPatchSchema({ type: ["integer", "null"], minimum: 1, maximum: 480 }),
    arrival_at: scalarPatchSchema(nullableDate),
    hard_leave_at: scalarPatchSchema(nullableDate),
    time_original_phrase: scalarPatchSchema({ type: ["string", "null"] }),
    location_area: scalarPatchSchema({ type: ["string", "null"] }),
    max_walk_minutes: scalarPatchSchema({ type: ["integer", "null"], minimum: 1, maximum: 90 }),
    hard_constraints: arrayPatchSchema(patchConstraintSchema),
    soft_preferences: arrayPatchSchema(patchPreferenceSchema),
    unknowns: stringArray,
    assumptions: stringArray,
  },
};

export const clarificationDecisionSchema = {
  $id: "https://quietlens.local/schema/clarification-decision-v0.1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "ClarificationDecision",
  type: "object",
  additionalProperties: false,
  required: [
    "flow_schema_version",
    "required",
    "target_field",
    "question_code",
    "option_codes",
    "conservative_assumption",
  ],
  properties: {
    flow_schema_version: { const: AI_FLOW_SCHEMA_VERSION },
    required: { type: "boolean" },
    target_field: { enum: [null, ...EVIDENCE_ATTRIBUTES] },
    question_code: { type: ["string", "null"], pattern: "^[a-z0-9_]+$" },
    option_codes: stringArray,
    conservative_assumption: { type: ["string", "null"] },
  },
};

const evidenceGroupSchema = {
  type: "object",
  additionalProperties: false,
  required: ["attribute", "evidence_ids"],
  properties: {
    attribute: { enum: EVIDENCE_ATTRIBUTES },
    evidence_ids: { ...evidenceIdArray, minItems: 1 },
  },
};

export const decisionDraftSchema = {
  $id: "https://quietlens.local/schema/decision-draft-v0.1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "DecisionDraft",
  type: "object",
  additionalProperties: false,
  required: ["flow_schema_version", "request_id", "outcome", "refusal_reason_code", "candidates"],
  properties: {
    flow_schema_version: { const: AI_FLOW_SCHEMA_VERSION },
    request_id: { type: "string", pattern: "^req-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    outcome: { enum: ["publish", "refuse"] },
    refusal_reason_code: { type: ["string", "null"], pattern: "^[a-z0-9_]+$" },
    candidates: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "place_id",
          "role",
          "fit_evidence_groups",
          "tradeoff_evidence_groups",
          "unknown_attributes",
          "assumption_refs",
        ],
        properties: {
          place_id: { type: "string", pattern: PLACE_ID_PATTERN },
          role: { enum: ["primary", "conditional", "alternative"] },
          fit_evidence_groups: { type: "array", items: evidenceGroupSchema },
          tradeoff_evidence_groups: { type: "array", items: evidenceGroupSchema },
          unknown_attributes: { type: "array", items: { enum: EVIDENCE_ATTRIBUTES }, uniqueItems: true },
          assumption_refs: stringArray,
        },
      },
    },
  },
};

export const decisionBriefSchema = {
  $id: "https://quietlens.local/schema/decision-brief-v0.1.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "DecisionBrief",
  type: "object",
  additionalProperties: false,
  required: [
    "flow_schema_version",
    "request_id",
    "status",
    "scope",
    "request",
    "candidates",
    "refusal",
    "versions",
  ],
  properties: {
    flow_schema_version: { const: AI_FLOW_SCHEMA_VERSION },
    request_id: { type: "string", pattern: "^req-[a-z0-9]+(?:-[a-z0-9]+)*$" },
    status: { enum: ["published", "refused"] },
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["coverage_scope", "place_count"],
      properties: {
        coverage_scope: { const: "huangpu-10-v0.1" },
        place_count: { const: 10 },
      },
    },
    request: decisionRequestSchema,
    candidates: { type: "array", maxItems: 3, items: decisionCandidateSchema },
    refusal: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["reason_code", "blocking_constraints", "relaxable_fields"],
      properties: {
        reason_code: { type: "string", pattern: "^[a-z0-9_]+$" },
        blocking_constraints: stringArray,
        relaxable_fields: { type: "array", items: { enum: EVIDENCE_ATTRIBUTES }, uniqueItems: true },
      },
    },
    versions: {
      type: "object",
      additionalProperties: false,
      required: ["contract_schema", "flow_schema", "evidence_store", "model", "prompt"],
      properties: {
        contract_schema: { const: CONTRACT_SCHEMA_VERSION },
        flow_schema: { const: AI_FLOW_SCHEMA_VERSION },
        evidence_store: { const: EVIDENCE_STORE_VERSION },
        model: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
      },
    },
  },
};

export const CONTRACT_SCHEMAS = {
  PlaceRecord: placeRecordSchema,
  SourceRecord: sourceRecordSchema,
  EvidenceRecord: evidenceRecordSchema,
  DecisionRequest: decisionRequestSchema,
  DecisionCandidate: decisionCandidateSchema,
  EvaluationCase: evaluationCaseSchema,
  AnalyticsEvent: analyticsEventSchema,
  DecisionRequestPatch: decisionRequestPatchSchema,
  ClarificationDecision: clarificationDecisionSchema,
  DecisionDraft: decisionDraftSchema,
  DecisionBrief: decisionBriefSchema,
};
