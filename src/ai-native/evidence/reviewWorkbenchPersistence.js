import { assertReviewContract } from "./reviewWorkbenchContracts.js";

export const REVIEW_WORKSPACE_STORAGE_KEY = "quietlens:evidence-review:synthetic:v1";
export const REVIEW_WORKSPACE_STORAGE_VERSION = "1.0.0";

function emptyWorkspace(status = "empty") {
  return {
    schema_version: REVIEW_WORKSPACE_STORAGE_VERSION,
    review_context: "synthetic_fixture",
    decisions: [],
    status,
  };
}

function validateWorkspace(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("REVIEW_WORKSPACE_INVALID");
  if (value.schema_version !== REVIEW_WORKSPACE_STORAGE_VERSION) throw new Error("REVIEW_WORKSPACE_VERSION_UNSUPPORTED");
  if (value.review_context !== "synthetic_fixture") throw new Error("PRODUCTION_REVIEW_PERSISTENCE_FORBIDDEN");
  if (!Array.isArray(value.decisions)) throw new Error("REVIEW_WORKSPACE_INVALID");
  const ids = new Set();
  for (const decision of value.decisions) {
    assertReviewContract("EvidenceReviewDecision", decision, decision?.decision_id);
    if (decision.review_context !== "synthetic_fixture") throw new Error("PRODUCTION_REVIEW_PERSISTENCE_FORBIDDEN");
    if (ids.has(decision.decision_id)) throw new Error("REVIEW_DECISION_DUPLICATED");
    ids.add(decision.decision_id);
  }
  return {
    schema_version: REVIEW_WORKSPACE_STORAGE_VERSION,
    review_context: "synthetic_fixture",
    decisions: [...value.decisions],
    status: value.decisions.length ? "ready" : "empty",
  };
}

export function loadSyntheticReviewWorkspace(storage) {
  if (!storage?.getItem) return emptyWorkspace("unavailable");
  const raw = storage.getItem(REVIEW_WORKSPACE_STORAGE_KEY);
  if (!raw) return emptyWorkspace();
  try {
    return validateWorkspace(JSON.parse(raw));
  } catch (error) {
    return { ...emptyWorkspace("corrupt"), error_code: error.message };
  }
}

export function appendSyntheticReviewDecision(storage, decision) {
  if (!storage?.setItem) throw new Error("REVIEW_WORKSPACE_STORAGE_UNAVAILABLE");
  assertReviewContract("EvidenceReviewDecision", decision, decision?.decision_id);
  if (decision.review_context !== "synthetic_fixture") throw new Error("PRODUCTION_REVIEW_PERSISTENCE_FORBIDDEN");
  const workspace = loadSyntheticReviewWorkspace(storage);
  if (workspace.status === "corrupt") throw new Error("REVIEW_WORKSPACE_CORRUPT");
  const existing = workspace.decisions.find((item) => item.decision_id === decision.decision_id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(decision)) throw new Error("REVIEW_DECISION_ID_COLLISION");
    return workspace;
  }
  const next = {
    schema_version: REVIEW_WORKSPACE_STORAGE_VERSION,
    review_context: "synthetic_fixture",
    decisions: [...workspace.decisions, decision],
  };
  storage.setItem(REVIEW_WORKSPACE_STORAGE_KEY, JSON.stringify(next));
  return { ...next, status: "ready" };
}

export function clearSyntheticReviewWorkspace(storage) {
  if (!storage?.removeItem) throw new Error("REVIEW_WORKSPACE_STORAGE_UNAVAILABLE");
  storage.removeItem(REVIEW_WORKSPACE_STORAGE_KEY);
  return emptyWorkspace();
}
