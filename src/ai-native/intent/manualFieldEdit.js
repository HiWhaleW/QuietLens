import { assertContract } from "../contracts/validator.js";

function withoutUnknowns(request, fields) {
  const removed = new Set(fields);
  request.unknowns = request.unknowns.filter((field) => !removed.has(field));
}

function localDateTime(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return `${value}:00+08:00`;
  return value;
}

export function applyManualFieldEdit(request, edit) {
  assertContract("DecisionRequest", request);
  const next = structuredClone(request);
  const changedFields = [];

  if (edit.kind === "task") {
    next.task.type = edit.task_type;
    next.task.duration_minutes = edit.duration_minutes || null;
    withoutUnknowns(next, ["task", "duration"]);
    changedFields.push("task_type", "duration_minutes");
  } else if (edit.kind === "time") {
    next.time.arrival_at = localDateTime(edit.arrival_at);
    next.time.original_phrase = null;
    withoutUnknowns(next, ["arrival_time"]);
    changedFields.push("arrival_at");
  } else if (edit.kind === "location") {
    next.location.area = edit.area.trim();
    withoutUnknowns(next, ["location"]);
    changedFields.push("location_area");
  } else if (edit.kind === "walk") {
    next.location.max_walk_minutes = edit.minutes || null;
    withoutUnknowns(next, ["walk_time"]);
    changedFields.push("max_walk_minutes");
  } else if (edit.kind === "preference") {
    next.soft_preferences = next.soft_preferences.filter((item) => item.field !== edit.field);
    if (edit.priority) next.soft_preferences.push({ field: edit.field, priority: edit.priority });
    changedFields.push("soft_preferences");
  } else if (edit.kind === "constraint") {
    const constraint = next.hard_constraints.find((item) => item.constraint_id === edit.constraint_id);
    next.hard_constraints = next.hard_constraints.filter((item) => item.constraint_id !== edit.constraint_id);
    if (edit.action === "preference" && constraint) {
      next.soft_preferences = [
        ...next.soft_preferences.filter((item) => item.field !== constraint.field),
        { field: constraint.field, priority: "high" },
      ];
    }
    changedFields.push("hard_constraints");
  } else if (edit.kind === "unknown") {
    next.unknowns = next.unknowns.filter((field) => field !== edit.field);
    changedFields.push("unknowns");
  } else {
    throw new Error("MANUAL_FIELD_EDIT_UNSUPPORTED");
  }

  next.confirmed_by_user = true;
  return {
    request: assertContract("DecisionRequest", next),
    changedFields: [...new Set(changedFields)],
  };
}
