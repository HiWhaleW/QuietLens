import { assertContract, validateContract } from "../contracts/validator.js";
import {
  AI_FLOW_SCHEMA_VERSION,
  CONTRACT_SCHEMA_VERSION,
  EVIDENCE_STORE_VERSION,
} from "../contracts/schemas.js";
import { calculateConfidence } from "./confidence.js";

const ATTRIBUTE_LABELS = {
  identity: "门店实体",
  address: "地址",
  coordinates: "位置",
  operating_status: "营业状态",
  opening_hours: "营业时间",
  facade: "临街环境",
  interior: "室内环境",
  size: "空间尺度",
  workspace: "工作空间",
  daylight: "自然光",
  seating: "座位",
  outlets: "插座",
  outdoor_seating: "户外座位",
  noise: "声环境",
  crowding: "拥挤程度",
  peak_time: "高峰时段",
  call_environment: "线上会议环境",
  walk_time: "步行时间",
  realtime_seats: "实时座位",
  realtime_noise: "实时声量",
};

const VALUE_LABELS = {
  strong: "已有较强自然光证据",
  window_facing: "已有临窗采光观察",
  quiet_working: "已有适合安静工作的观察",
  social_loud: "已有偏社交、声量较高的观察",
  afternoon_high: "下午可能较拥挤",
  near_full_after_13: "13:00 后曾出现接近满座的观察",
  seasonal_high: "特定季节可能较拥挤",
  weekday_before_09_full: "工作日早间曾出现满座观察",
  morning_commute: "早高峰可能更繁忙",
  comfortable_work_seating: "已有适合工作的座位观察",
  limited: "座位条件有限",
  window_and_garden: "有临窗或花园座位观察",
  antique_garden_interior: "古董陈设与花园感室内",
  blue_frames_gray_brick: "蓝色窗框与灰砖外观",
  bookshelves_garden_glass: "书架、花园与玻璃空间",
  cream_wood_terrazzo: "浅色木质与水磨石室内",
  glass_dark_frames: "深色窗框与玻璃外观",
  gray_stone_dark_wood: "灰石与深色木质外观",
  large_windows_garden: "大窗与花园空间",
  low_white_large_glass: "低层白色建筑与大面积玻璃",
  red_brick_black_doors: "红砖与黑色门面",
  small: "空间体量较小",
  small_white_open_ledge: "白色小体量开放式窗口",
  two_story_red_brick: "两层红砖建筑",
  verified_storefront: "门店外观已核实",
  warm_glass_interior: "暖色玻璃室内",
  warm_wood_display: "暖色木质与陈列空间",
  wood_garden_interior: "木质与花园感室内",
};

const ALWAYS_CHECK_UNKNOWN_ATTRIBUTES = ["realtime_seats", "realtime_noise"];

function evidenceSummary(records) {
  const values = records
    .map((record) => record.normalized_value)
    .filter((value) => value !== null)
    .map((value) => {
      if (typeof value === "boolean") return value ? "已有可用证据" : "已有不可用证据";
      if (Array.isArray(value)) return "已有核实记录";
      return VALUE_LABELS[value] ?? String(value);
    });
  return [...new Set(values)].join("；") || "现有资料只支持有限判断";
}

function renderReasons(groups, evidenceById, kind) {
  return groups.map((group) => {
    const records = group.evidence_ids.map((id) => evidenceById.get(id)).filter(Boolean);
    const label = ATTRIBUTE_LABELS[group.attribute] ?? group.attribute;
    return {
      text: kind === "fit"
        ? `${label}：${evidenceSummary(records)}`
        : `${label}需权衡：${evidenceSummary(records)}`,
      evidence_ids: group.evidence_ids,
    };
  });
}

function verifyGroup(group, candidate, evidenceById, retrievedIds, issues) {
  for (const evidenceId of group.evidence_ids) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) issues.push({ code: "EVIDENCE_ID_MISSING", detail: evidenceId });
    else if (!retrievedIds.has(evidenceId)) issues.push({ code: "EVIDENCE_NOT_RETRIEVED", detail: evidenceId });
    else if (evidence.place_id !== candidate.place_id) issues.push({ code: "EVIDENCE_PLACE_MISMATCH", detail: evidenceId });
    else if (evidence.attribute !== group.attribute) issues.push({ code: "EVIDENCE_ATTRIBUTE_MISMATCH", detail: evidenceId });
    else if (evidence.publishability === "not_factual" || evidence.epistemic_status === "model_inference") {
      issues.push({ code: "EVIDENCE_NOT_PUBLISHABLE", detail: evidenceId });
    }
  }
}

function groundedUnknownAttributes(candidate, retrieved, request, store) {
  const requested = new Set([
    ...ALWAYS_CHECK_UNKNOWN_ATTRIBUTES,
    ...request.hard_constraints.map((constraint) => constraint.field),
    ...request.soft_preferences.map((preference) => preference.field),
    ...request.unknowns,
    ...candidate.unknown_attributes,
  ]);
  const recordsByAttribute = new Map();
  for (const record of store.evidence.filter((record) => record.place_id === candidate.place_id)) {
    const records = recordsByAttribute.get(record.attribute) ?? [];
    records.push(record);
    recordsByAttribute.set(record.attribute, records);
  }
  const unknowns = new Set();
  for (const attribute of requested) {
    const records = recordsByAttribute.get(attribute) ?? [];
    const hasUnknownRecord = records.some((record) => record.epistemic_status === "unknown");
    const hasFactualValue = records.some((record) => (
      record.normalized_value !== null
      && record.epistemic_status !== "unknown"
      && record.publishability !== "not_factual"
    ));
    if (hasUnknownRecord && !hasFactualValue) unknowns.add(attribute);
  }
  const constraintById = new Map(request.hard_constraints.map((constraint) => [constraint.constraint_id, constraint]));
  for (const result of retrieved.hard_constraint_results.filter((item) => item.status === "unknown")) {
    const attribute = constraintById.get(result.constraint_id)?.field;
    if (attribute) unknowns.add(attribute);
  }
  return [...unknowns];
}

function refusalBrief(request, reasonCode, versions, retrieval) {
  const blocking = retrieval.rejected.flatMap((entry) => (
    entry.results.filter((result) => result.status === "fail").map((result) => result.constraint_id)
  ));
  return {
    flow_schema_version: AI_FLOW_SCHEMA_VERSION,
    request_id: request.request_id,
    status: "refused",
    scope: { coverage_scope: "huangpu-10-v0.1", place_count: 10 },
    request,
    candidates: [],
    refusal: {
      reason_code: reasonCode,
      blocking_constraints: [...new Set(blocking)],
      relaxable_fields: [...new Set(request.hard_constraints.map((constraint) => constraint.field))],
    },
    versions,
  };
}

export function verifyAndRenderDecisionDraft({ draft, request, retrieval, store, modelVersion, promptVersion }) {
  assertContract("DecisionRequest", request);
  const draftValidation = validateContract("DecisionDraft", draft);
  const versions = {
    contract_schema: CONTRACT_SCHEMA_VERSION,
    flow_schema: AI_FLOW_SCHEMA_VERSION,
    evidence_store: EVIDENCE_STORE_VERSION,
    model: modelVersion,
    prompt: promptVersion,
  };
  if (!draftValidation.valid) {
    return { valid: false, issues: draftValidation.errors.map((error) => ({ code: "DRAFT_SCHEMA_INVALID", detail: error })) };
  }
  if (draft.request_id !== request.request_id) {
    return { valid: false, issues: [{ code: "DRAFT_REQUEST_MISMATCH", detail: draft.request_id }] };
  }
  if (draft.outcome === "refuse") {
    const comparableCandidateCount = retrieval.candidates.filter((candidate) => (
      candidate.eligibility === "eligible"
      && candidate.evidence.some((record) => (
        record.publishability !== "not_factual"
        && record.epistemic_status !== "model_inference"
      ))
    )).length;
    if (comparableCandidateCount >= 2) {
      return {
        valid: false,
        issues: [{ code: "MODEL_REFUSAL_UNSUPPORTED", detail: comparableCandidateCount }],
      };
    }
    const brief = refusalBrief(request, draft.refusal_reason_code ?? "model_refused", versions, retrieval);
    assertContract("DecisionBrief", brief);
    return { valid: true, issues: [], brief };
  }

  const issues = [];
  const allowed = new Map(retrieval.candidates.map((candidate) => [candidate.place.place_id, candidate]));
  const evidenceById = new Map(store.evidence.map((record) => [record.evidence_id, record]));
  const selectedIds = new Set();
  const roles = new Set();
  const candidates = [];

  const eligibleCandidateCount = retrieval.candidates.filter((candidate) => candidate.eligibility === "eligible").length;
  if (draft.candidates.length < 1
    || draft.candidates.length > 3
    || (draft.candidates.length === 1 && eligibleCandidateCount !== 1)) {
    issues.push({ code: "CANDIDATE_COUNT_INVALID", detail: draft.candidates.length });
  }

  for (const candidate of draft.candidates) {
    const retrieved = allowed.get(candidate.place_id);
    if (!retrieved) {
      issues.push({ code: "CANDIDATE_OUTSIDE_ALLOWLIST", detail: candidate.place_id });
      continue;
    }
    if (selectedIds.has(candidate.place_id)) issues.push({ code: "CANDIDATE_DUPLICATE", detail: candidate.place_id });
    if (roles.has(candidate.role)) issues.push({ code: "CANDIDATE_ROLE_DUPLICATE", detail: candidate.role });
    selectedIds.add(candidate.place_id);
    roles.add(candidate.role);
    if (candidate.role === "primary" && retrieved.eligibility !== "eligible") {
      issues.push({ code: "PRIMARY_HARD_CONSTRAINT_UNCONFIRMED", detail: candidate.place_id });
    }
    if (candidate.role !== "primary" && retrieved.eligibility === "uncertain") {
      const hasUnknownHardConstraint = retrieved.hard_constraint_results.some((result) => result.status === "unknown");
      if (!hasUnknownHardConstraint) issues.push({ code: "CONDITIONAL_STATUS_INVALID", detail: candidate.place_id });
    }

    const retrievedIds = new Set(retrieved.evidence.map((record) => record.evidence_id));
    for (const group of [...candidate.fit_evidence_groups, ...candidate.tradeoff_evidence_groups]) {
      verifyGroup(group, candidate, evidenceById, retrievedIds, issues);
    }
    if (candidate.fit_evidence_groups.length === 0) {
      issues.push({ code: "FIT_REASON_MISSING", detail: candidate.place_id });
    }
    const unknownAttributes = groundedUnknownAttributes(candidate, retrieved, request, store);
    const unknownSet = new Set(unknownAttributes);
    for (const hardResult of retrieved.hard_constraint_results.filter((result) => result.status === "unknown")) {
      const field = request.hard_constraints.find((constraint) => constraint.constraint_id === hardResult.constraint_id)?.field;
      if (field && !unknownSet.has(field)) issues.push({ code: "HARD_UNKNOWN_NOT_DISCLOSED", detail: `${candidate.place_id}:${field}` });
    }
    for (const assumption of candidate.assumption_refs) {
      if (!request.assumptions.includes(assumption)) issues.push({ code: "ASSUMPTION_NOT_REGISTERED", detail: assumption });
    }

    candidates.push({
      schema_version: CONTRACT_SCHEMA_VERSION,
      request_id: request.request_id,
      place_id: candidate.place_id,
      role: candidate.role,
      hard_constraint_results: retrieved.hard_constraint_results,
      fit_reasons: renderReasons(candidate.fit_evidence_groups, evidenceById, "fit"),
      tradeoffs: renderReasons(candidate.tradeoff_evidence_groups, evidenceById, "tradeoff"),
      unknowns: unknownAttributes,
      confidence: calculateConfidence(request, retrieved, retrieved.evidence),
      assumptions: candidate.assumption_refs,
    });
  }

  if (!roles.has("primary")) issues.push({ code: "PRIMARY_CANDIDATE_MISSING", detail: request.request_id });
  if (issues.length > 0) return { valid: false, issues };
  for (const candidate of candidates) assertContract("DecisionCandidate", candidate);

  const brief = {
    flow_schema_version: AI_FLOW_SCHEMA_VERSION,
    request_id: request.request_id,
    status: "published",
    scope: { coverage_scope: "huangpu-10-v0.1", place_count: 10 },
    request,
    candidates,
    refusal: null,
    versions,
  };
  assertContract("DecisionBrief", brief);
  return { valid: true, issues: [], brief };
}

export function renderDeterministicRefusal({ request, retrieval, reasonCode, modelVersion, promptVersion }) {
  const versions = {
    contract_schema: CONTRACT_SCHEMA_VERSION,
    flow_schema: AI_FLOW_SCHEMA_VERSION,
    evidence_store: EVIDENCE_STORE_VERSION,
    model: modelVersion,
    prompt: promptVersion,
  };
  const brief = refusalBrief(request, reasonCode, versions, retrieval);
  assertContract("DecisionBrief", brief);
  return brief;
}

export function renderDeterministicSingleCandidate({ request, retrieval, store }) {
  const eligible = retrieval.candidates.filter((candidate) => candidate.eligibility === "eligible");
  if (eligible.length !== 1) throw new Error("DETERMINISTIC_SINGLE_CANDIDATE_INVALID");
  const candidate = eligible[0];
  const constraintById = new Map(request.hard_constraints.map((constraint) => [constraint.constraint_id, constraint]));
  const evidenceByAttribute = new Map();
  for (const result of candidate.hard_constraint_results.filter((item) => item.status === "pass")) {
    const attribute = constraintById.get(result.constraint_id)?.field;
    if (!attribute || result.evidence_ids.length === 0) continue;
    evidenceByAttribute.set(attribute, [
      ...new Set([...(evidenceByAttribute.get(attribute) ?? []), ...result.evidence_ids]),
    ]);
  }
  const draft = {
    flow_schema_version: AI_FLOW_SCHEMA_VERSION,
    request_id: request.request_id,
    outcome: "publish",
    refusal_reason_code: null,
    candidates: [{
      place_id: candidate.place.place_id,
      role: "primary",
      fit_evidence_groups: [...evidenceByAttribute].map(([attribute, evidence_ids]) => ({ attribute, evidence_ids })),
      tradeoff_evidence_groups: [],
      unknown_attributes: ["realtime_seats", "realtime_noise"],
      assumption_refs: request.assumptions,
    }],
  };
  const result = verifyAndRenderDecisionDraft({
    draft,
    request,
    retrieval,
    store,
    modelVersion: "not-invoked",
    promptVersion: "deterministic-single-candidate-v0.1.0",
  });
  if (!result.valid) {
    const error = new Error("DETERMINISTIC_SINGLE_CANDIDATE_INVALID");
    error.code = "DETERMINISTIC_SINGLE_CANDIDATE_INVALID";
    error.details = result.issues;
    throw error;
  }
  return result;
}
