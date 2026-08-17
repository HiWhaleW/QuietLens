import { assertContract } from "../contracts/validator.js";
import { AI_FLOW_SCHEMA_VERSION } from "../contracts/schemas.js";
import { isAreaWithinScope } from "../evidence/retrieveEvidence.js";
import { hasTimeWindowConflict } from "./requestPatch.js";

const CLARIFICATIONS = {
  call_environment: {
    question_code: "call_environment_requirement",
    option_codes: ["need_stable_background", "leave_before_call", "use_conservative_assumption"],
    conservative_assumption: "无法确认店内是否适合线上会议；不把通话环境视为已满足。",
  },
  walk_time: {
    question_code: "maximum_walk_time",
    option_codes: ["walk_10", "walk_15", "walk_20", "use_conservative_assumption"],
    conservative_assumption: "暂按最多步行 15 分钟比较。",
  },
  outlets: {
    question_code: "outlet_requirement",
    option_codes: ["outlets_required", "outlets_preferred", "use_conservative_assumption"],
    conservative_assumption: "插座状态未核实，不将其视为硬约束已满足。",
  },
  seating: {
    question_code: "seating_requirement",
    option_codes: ["work_seating_required", "any_seating_ok", "use_conservative_assumption"],
    conservative_assumption: "座位舒适度未核实，最终简报将保留未知。",
  },
  noise: {
    question_code: "noise_tolerance",
    option_codes: ["quiet_required", "background_voice_ok", "use_conservative_assumption"],
    conservative_assumption: "按低噪声优先，但不把未核实声量视为安静。",
  },
  crowding: {
    question_code: "crowding_tolerance",
    option_codes: ["low_crowding_required", "moderate_crowding_ok", "use_conservative_assumption"],
    conservative_assumption: "实时人流未知，不承诺当前低拥挤。",
  },
  daylight: {
    question_code: "daylight_priority",
    option_codes: ["daylight_high", "daylight_optional", "use_conservative_assumption"],
    conservative_assumption: "自然光作为普通偏好，缺少证据时保持未知。",
  },
};

function noClarification() {
  return {
    flow_schema_version: AI_FLOW_SCHEMA_VERSION,
    required: false,
    target_field: null,
    question_code: null,
    option_codes: [],
    conservative_assumption: null,
  };
}

export function chooseClarification(request, { alreadyAsked = false, preferredTarget = null } = {}) {
  assertContract("DecisionRequest", request);
  if (alreadyAsked) return assertContract("ClarificationDecision", noClarification());
  if (!isAreaWithinScope(request.location.area) || hasTimeWindowConflict(request)) {
    return assertContract("ClarificationDecision", noClarification());
  }
  const explicitHardFields = new Set(request.hard_constraints.map((constraint) => constraint.field));
  const unresolved = request.unknowns.filter((field) => (
    CLARIFICATIONS[field] && !explicitHardFields.has(field)
  ));
  const target = preferredTarget && unresolved.includes(preferredTarget)
    ? preferredTarget
    : null;
  if (!target) return assertContract("ClarificationDecision", noClarification());

  return assertContract("ClarificationDecision", {
    flow_schema_version: AI_FLOW_SCHEMA_VERSION,
    required: true,
    target_field: target,
    ...CLARIFICATIONS[target],
  });
}

function nextConstraintId(request) {
  return `hc-${request.request_id.replace(/^req-/, "")}-${request.hard_constraints.length + 1}`;
}

export function applyClarificationAnswer(request, clarification, answerCode) {
  assertContract("DecisionRequest", request);
  assertContract("ClarificationDecision", clarification);
  if (!clarification.required || !clarification.option_codes.includes(answerCode)) {
    throw new Error("CLARIFICATION_ANSWER_INVALID");
  }

  const next = structuredClone(request);
  const target = clarification.target_field;
  next.unknowns = next.unknowns.filter((field) => field !== target);

  if (answerCode === "use_conservative_assumption") {
    next.assumptions = [...new Set([...next.assumptions, clarification.conservative_assumption])];
  } else if (answerCode.startsWith("walk_")) {
    next.location.max_walk_minutes = Number(answerCode.slice(5));
  } else if (answerCode === "need_stable_background") {
    next.hard_constraints.push({
      constraint_id: nextConstraintId(next),
      field: "call_environment",
      operator: "supports",
      value: "stable_background",
    });
  } else if (answerCode === "leave_before_call") {
    next.assumptions = [...new Set([...next.assumptions, "线上会议前离店，不要求门店支持通话。"] )];
  } else if (answerCode === "outlets_required") {
    next.hard_constraints.push({
      constraint_id: nextConstraintId(next),
      field: "outlets",
      operator: "available",
      value: true,
    });
  } else if (answerCode === "outlets_preferred") {
    next.soft_preferences = [...next.soft_preferences.filter((item) => item.field !== "outlets"), { field: "outlets", priority: "high" }];
  } else if (answerCode === "work_seating_required") {
    next.hard_constraints.push({
      constraint_id: nextConstraintId(next),
      field: "seating",
      operator: "supports",
      value: "comfortable_work_seating",
    });
  } else if (answerCode === "any_seating_ok") {
    next.soft_preferences = next.soft_preferences.filter((item) => item.field !== "seating");
  } else if (answerCode === "quiet_required") {
    next.hard_constraints.push({
      constraint_id: nextConstraintId(next),
      field: "noise",
      operator: "supports",
      value: "quiet_working",
    });
  } else if (answerCode === "background_voice_ok") {
    next.soft_preferences = [...next.soft_preferences.filter((item) => item.field !== "noise"), { field: "noise", priority: "medium" }];
  } else if (answerCode === "low_crowding_required") {
    next.soft_preferences = [...next.soft_preferences.filter((item) => item.field !== "crowding"), { field: "crowding", priority: "high" }];
  } else if (answerCode === "moderate_crowding_ok") {
    next.soft_preferences = [...next.soft_preferences.filter((item) => item.field !== "crowding"), { field: "crowding", priority: "low" }];
  } else if (answerCode === "daylight_high") {
    next.soft_preferences = [...next.soft_preferences.filter((item) => item.field !== "daylight"), { field: "daylight", priority: "high" }];
  } else if (answerCode === "daylight_optional") {
    next.soft_preferences = [...next.soft_preferences.filter((item) => item.field !== "daylight"), { field: "daylight", priority: "low" }];
  }

  next.confirmed_by_user = true;
  return assertContract("DecisionRequest", next);
}
