import { assertContract } from "../contracts/validator.js";

export const EVENT_DEFINITIONS = Object.freeze({
  decision_request_submitted: ["input_length_bucket", "entry_context"],
  page_state_viewed: ["state_code"],
  decision_brief_viewed: ["candidate_count", "unknown_count", "assumption_count"],
  intent_summary_viewed: ["field_count", "unknown_count"],
  intent_field_edit_started: ["field_name", "previous_state"],
  intent_field_updated: ["field_name", "change_type"],
  candidate_list_viewed: ["candidate_count", "role_order"],
  candidate_card_viewed: ["place_id", "role", "confidence_level", "evidence_count"],
  candidate_marker_viewed: ["place_id", "role"],
  candidate_selected: ["place_id", "role", "source"],
  exploration_marker_viewed: ["place_id", "score_bucket", "eligibility"],
  exploration_place_selected: ["place_id", "score_bucket", "eligibility", "source"],
  map_board_changed: ["from_region", "to_region", "source"],
  header_menu_opened: ["page_state"],
  header_menu_action_selected: ["action_code"],
  decision_summary_viewed: ["claim_count", "unknown_count"],
  assumption_viewed: ["assumption_type"],
  unknowns_viewed: ["unknown_types"],
  evidence_scope_viewed: ["place_scope_count", "source_type_count"],
  evidence_record_viewed: ["place_id", "evidence_id", "attribute"],
  evidence_source_opened: ["place_id", "source_id", "source_type"],
  data_method_opened: ["source"],
  advanced_refinement_opened: ["candidate_count_before"],
  advanced_refinement_applied: ["changed_fields", "candidate_count_after"],
  correction_started: [],
  correction_submitted: ["changed_field_count"],
  correction_result_viewed: ["changed_field_count", "candidate_changed"],
  intent_parse_started: [],
  intent_parse_succeeded: ["duration_ms"],
  intent_parse_failed: ["duration_ms"],
  clarification_viewed: ["target_field"],
  clarification_answered: ["target_field", "answer_code"],
  clarification_skipped: ["target_field", "conservative_assumption_used"],
  retrieval_started: [],
  retrieval_succeeded: ["hit_count", "duration_ms"],
  retrieval_failed: ["duration_ms"],
  decision_reasoning_started: ["candidate_count"],
  decision_reasoning_succeeded: ["candidate_count", "duration_ms"],
  decision_reasoning_failed: ["duration_ms"],
  evidence_verification_succeeded: ["claim_count", "citation_count"],
  evidence_verification_blocked: ["claim_count", "citation_count", "blocking_error_code"],
  decision_published: ["candidate_count", "unknown_count", "total_duration_ms"],
  place_detail_opened: ["place_id", "source"],
  store_profile_viewed: ["place_id", "recommendation_status", "profile_version"],
  place_detail_closed: ["place_id", "close_source", "request_preserved"],
  decision_refusal_viewed: ["refusal_type", "hard_constraint_count", "relaxable_fields"],
  new_decision_started: ["previous_request_status"],
  feedback_entry_opened: ["place_id"],
  feedback_cancelled: ["place_id"],
  feedback_candidate_submitted: ["place_id", "candidate_observation_count"],
});

const FORBIDDEN_KEY_PARTS = [
  "raw_text",
  "raw_request",
  "content",
  "correction_text",
  "chain_of_thought",
  "cot",
  "prompt_text",
  "source_url",
  "local_path",
  "precise_location",
  "phone",
  "email",
  "api_key",
  "secret",
];

const SENSITIVE_VALUE_PATTERNS = [
  /(?:^|\s)\/[A-Za-z0-9._/-]+/,
  /[A-Z]:\\/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:api[_-]?key|bearer)\s*[:= ]\s*\S+/i,
];

export function findPrivacyViolations(value, path = "$") {
  const violations = [];

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      violations.push(...findPrivacyViolations(entry, `${path}[${index}]`));
    });
    return violations;
  }

  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (FORBIDDEN_KEY_PARTS.some((part) => normalizedKey.includes(part))) {
        violations.push(`${path}.${key}:forbidden_key`);
      }
      violations.push(...findPrivacyViolations(entry, `${path}.${key}`));
    }
    return violations;
  }

  if (typeof value === "string" && SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    violations.push(`${path}:sensitive_value`);
  }

  return violations;
}

export function validateAnalyticsEvent(event) {
  const issues = [];
  try {
    assertContract("AnalyticsEvent", event);
  } catch (error) {
    issues.push({ code: "EVENT_SCHEMA_INVALID", detail: error.message });
  }

  const requiredProperties = EVENT_DEFINITIONS[event.event_name];
  if (!requiredProperties) {
    issues.push({ code: "EVENT_NAME_UNKNOWN", detail: event.event_name });
  } else {
    for (const property of requiredProperties) {
      if (!(property in (event.properties ?? {}))) {
        issues.push({ code: "EVENT_PROPERTY_MISSING", detail: property });
      }
    }
  }

  for (const violation of findPrivacyViolations(event)) {
    issues.push({ code: "EVENT_PRIVACY_VIOLATION", detail: violation });
  }

  return { valid: issues.length === 0, issues };
}

export function assertAnalyticsEvent(event) {
  const result = validateAnalyticsEvent(event);
  if (!result.valid) {
    throw new Error(result.issues.map((issue) => `${issue.code}:${issue.detail}`).join("; "));
  }
  return event;
}
