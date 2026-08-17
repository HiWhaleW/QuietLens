import { assertContract } from "../contracts/validator.js";
import {
  AI_FLOW_SCHEMA_VERSION,
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_STORE_VERSION,
} from "../contracts/schemas.js";

const FIELD_TARGETS = {
  task_type: ["task", "type"],
  duration_minutes: ["task", "duration_minutes"],
  arrival_at: ["time", "arrival_at"],
  hard_leave_at: ["time", "hard_leave_at"],
  time_original_phrase: ["time", "original_phrase"],
  location_area: ["location", "area"],
  max_walk_minutes: ["location", "max_walk_minutes"],
};

const UNKNOWN_BY_PATCH_FIELD = {
  task_type: "task",
  duration_minutes: "duration",
  arrival_at: "arrival_time",
  hard_leave_at: "leave_time",
  location_area: "location",
  max_walk_minutes: "walk_time",
};

function clone(value) {
  return structuredClone(value);
}

function setAtPath(target, path, value) {
  target[path[0]][path[1]] = value;
}

function getAtPath(target, path) {
  return target[path[0]][path[1]];
}

function parseConstraintValue(operator, value) {
  if (operator === "available") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  if (["at_least", "at_most"].includes(operator)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value;
    }
  }
  return value;
}

function canonicalConstraint(constraint) {
  if (["outlets", "outdoor_seating", "operating_status", "realtime_seats"].includes(constraint.field)) {
    return { ...constraint, operator: "available", value: "true" };
  }
  if (constraint.field === "noise"
    && ["equals", "supports"].includes(constraint.operator)
    && ["quiet", "quiet_working", "low_noise", "silent"].includes(String(constraint.value).toLowerCase())) {
    return { ...constraint, operator: "equals", value: "quiet_working" };
  }
  return constraint;
}

function normalizedConstraints(requestId, constraints) {
  return constraints.map((constraint, index) => ({
    constraint_id: `hc-${requestId.replace(/^req-/, "")}-${index + 1}`,
    ...canonicalConstraint(constraint),
  })).map((constraint) => ({
    ...constraint,
    value: parseConstraintValue(constraint.operator, constraint.value),
  }));
}

function valuesDiffer(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export function createEmptyDecisionRequest(requestId, area = "黄浦区") {
  const request = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    request_id: requestId,
    evidence_store_version: EVIDENCE_STORE_VERSION,
    task: { type: "other", duration_minutes: null },
    time: { arrival_at: null, hard_leave_at: null, original_phrase: null },
    location: { area, max_walk_minutes: null },
    hard_constraints: [],
    soft_preferences: [],
    unknowns: ["task", "duration", "arrival_time", "walk_time"],
    assumptions: [],
    confirmed_by_user: false,
  };
  return assertContract("DecisionRequest", request);
}

export function createKeepPatch(requestId, mode = "correction") {
  const scalar = { action: "keep", value: null, confidence: "low" };
  return {
    flow_schema_version: AI_FLOW_SCHEMA_VERSION,
    request_id: requestId,
    mode,
    task_type: clone(scalar),
    duration_minutes: clone(scalar),
    arrival_at: clone(scalar),
    hard_leave_at: clone(scalar),
    time_original_phrase: clone(scalar),
    location_area: clone(scalar),
    max_walk_minutes: clone(scalar),
    hard_constraints: { action: "keep", value: [], confidence: "low" },
    soft_preferences: { action: "keep", value: [], confidence: "low" },
    unknowns: [],
    assumptions: [],
  };
}

export function mergeDecisionRequestPatch(currentRequest, patch) {
  assertContract("DecisionRequest", currentRequest);
  assertContract("DecisionRequestPatch", patch);
  if (currentRequest.request_id !== patch.request_id) {
    throw new Error("REQUEST_PATCH_ID_MISMATCH");
  }

  const next = clone(currentRequest);
  const changes = [];
  const resolvedUnknowns = new Set();

  for (const [field, path] of Object.entries(FIELD_TARGETS)) {
    const operation = patch[field];
    if (operation.action === "keep") continue;
    const before = getAtPath(next, path);
    const after = operation.action === "clear" ? null : operation.value;
    setAtPath(next, path, after);
    if (valuesDiffer(before, after)) changes.push({ field, before, after });
    if (operation.action === "set") resolvedUnknowns.add(UNKNOWN_BY_PATCH_FIELD[field]);
  }

  for (const [field, target] of [
    ["hard_constraints", "hard_constraints"],
    ["soft_preferences", "soft_preferences"],
  ]) {
    const operation = patch[field];
    if (operation.action === "keep") continue;
    const before = clone(next[target]);
    next[target] = operation.action === "clear"
      ? []
      : field === "hard_constraints"
        ? normalizedConstraints(next.request_id, operation.value)
        : clone(operation.value);
    if (valuesDiffer(before, next[target])) changes.push({ field, before, after: clone(next[target]) });
  }

  const retainedUnknowns = next.unknowns.filter((field) => !resolvedUnknowns.has(field));
  next.unknowns = [...new Set([...retainedUnknowns, ...patch.unknowns])];
  next.assumptions = patch.mode === "initial"
    ? [...new Set(patch.assumptions)]
    : [...new Set([...next.assumptions, ...patch.assumptions])];
  next.confirmed_by_user = false;

  assertContract("DecisionRequest", next);
  return { request: next, changes };
}

export function hasTimeWindowConflict(request) {
  assertContract("DecisionRequest", request);
  if (!request.time.arrival_at || !request.time.hard_leave_at || !request.task.duration_minutes) return false;
  const arrival = Date.parse(request.time.arrival_at);
  const leave = Date.parse(request.time.hard_leave_at);
  if (!Number.isFinite(arrival) || !Number.isFinite(leave)) return false;
  return arrival + request.task.duration_minutes * 60_000 > leave;
}
