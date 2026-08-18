export const EXPLORATION_SCORE_VERSION = "ai-intent-sensory-reference-v0.2.0";
export const SENSORY_REFERENCE_PROFILE_VERSION = "legacy-sensory-profile-v0.1.0";

const FACTUAL_STATUSES = new Set(["verified_fact", "sourced_observation"]);
const PRIORITY_WEIGHTS = { low: 1, medium: 2, high: 3 };
const TASK_DIMENSIONS = {
  focus: ["workspace", "noise", "crowding", "daylight", "seating", "outlets"],
  recovery: ["noise", "crowding", "daylight", "outdoor_seating", "seating"],
  conversation: ["noise", "crowding", "seating", "outdoor_seating"],
  call: ["call_environment", "noise", "crowding", "outlets"],
  other: ["noise", "crowding", "daylight", "seating"],
};

export const SENSORY_DIMENSIONS = ["quiet", "uncrowded", "daylight", "seating"];
export const SENSORY_DIMENSION_LABELS = {
  quiet: "安静度",
  uncrowded: "低拥挤",
  daylight: "自然光",
  seating: "座位友好",
};
const TASK_REFERENCE_WEIGHTS = {
  focus: { quiet: 95, uncrowded: 82, daylight: 52, seating: 88 },
  recovery: { quiet: 78, uncrowded: 86, daylight: 82, seating: 65 },
  conversation: { quiet: 48, uncrowded: 62, daylight: 80, seating: 74 },
  call: { quiet: 94, uncrowded: 84, daylight: 45, seating: 82 },
  other: { quiet: 75, uncrowded: 75, daylight: 75, seating: 75 },
};
const PREFERENCE_WEIGHT_FLOORS = { low: 85, medium: 115, high: 150 };
const FIELD_TO_SENSORY_DIMENSIONS = {
  noise: ["quiet"],
  crowding: ["uncrowded"],
  daylight: ["daylight"],
  seating: ["seating"],
  workspace: ["quiet", "seating"],
  call_environment: ["quiet", "uncrowded"],
  outdoor_seating: ["seating", "daylight"],
};

// These are inherited editorial references, not verified or real-time observations.
const EDITORIAL_SENSORY_REFERENCES = {
  "hp-naive": {
    scores: { quiet: 89, uncrowded: 77, daylight: 71, seating: 86 }, weekendPenalty: 15,
    confidence: 86, bestTime: "工作日 10:00–15:00",
    evidence: "工作日下午背景音乐稳定，交谈声较低。",
    sourceStatus: "门店实拍已核实，感官证据待逐条审核",
  },
  "hp-omnibus": {
    scores: { quiet: 92, uncrowded: 85, daylight: 64, seating: 73 }, weekendPenalty: 9,
    confidence: 81, bestTime: "工作日 09:00–15:00",
    evidence: "企鹅吃喝指南多次回访：店内白板展示每日手冲参数，空间以巴士主题为主。",
    sourceStatus: "门店、地址与实拍已交叉核实；感官分数待现场采样",
  },
  "hp-cafe-on-air": {
    scores: { quiet: 80, uncrowded: 70, daylight: 88, seating: 82 }, weekendPenalty: 17,
    confidence: 82, bestTime: "工作日 10:00–12:30",
    evidence: "企鹅吃喝指南实访：多数人安静办公，大窗采光充足，长桌插座多；13:00 已接近满座。",
    sourceStatus: "门店、地址、实拍与感官证据已交叉核实；分数为编辑估计",
  },
  "hp-blue-house": {
    scores: { quiet: 76, uncrowded: 70, daylight: 70, seating: 74 }, weekendPenalty: 8,
    confidence: 80, bestTime: "工作日上午（待现场采样）",
    evidence: "记者走访确认窗边与户外座位；安静度与工作适配仍待现场采样。",
    sourceStatus: "门店、地址、坐标与实拍已交叉核实；感官分数待现场采样",
  },
  "hp-metal-hands": {
    scores: { quiet: 77, uncrowded: 70, daylight: 76, seating: 63 }, weekendPenalty: 16,
    confidence: 79, bestTime: "避开早高峰（待现场采样）",
    evidence: "永嘉路店采访确认木质书架、后花园玻璃窗和户外座位；早高峰客流较多。",
    sourceStatus: "门店、地址、坐标与实拍已交叉核实；感官分数待现场采样",
  },
  "hp-antique": {
    scores: { quiet: 81, uncrowded: 71, daylight: 86, seating: 79 }, weekendPenalty: 20,
    confidence: 78, bestTime: "避开下午茶高峰（待现场采样）",
    evidence: "2024 实访确认两层古董空间、庭院与靠窗座位；下午较难抢座。",
    sourceStatus: "门店、地址、坐标与实拍已交叉核实；感官分数待现场采样",
  },
  "hp-one-tenth": {
    scores: { quiet: 75, uncrowded: 64, daylight: 72, seating: 68 }, weekendPenalty: 17,
    confidence: 74, bestTime: "工作日上午（待现场采样）",
    evidence: "当前地图实拍确认窄幅木框临街立面；座位、声量与客流仍待现场核实。",
    sourceStatus: "品牌纠错、门店、地址、坐标与实拍已交叉核实；感官分数待现场采样",
  },
  "hp-shiteng": {
    scores: { quiet: 74, uncrowded: 67, daylight: 61, seating: 70 }, weekendPenalty: 15,
    confidence: 72, bestTime: "避开高峰（待现场采样）",
    evidence: "近期实访确认小体量门店、半开放窗台与少量座位。",
    sourceStatus: "门店、地址、坐标与实拍已交叉核实；感官分数待现场采样",
  },
  "hp-naive-tree": {
    scores: { quiet: 84, uncrowded: 80, daylight: 67, seating: 68 }, weekendPenalty: 10,
    confidence: 72, bestTime: "避开高峰（待现场采样）",
    evidence: "门店资料确认 22㎡小体量空间、室外折叠椅与紧凑客座。",
    sourceStatus: "门店、地址、坐标与实拍已交叉核实；门牌差异已记录；感官分数待现场采样",
  },
  "hp-east-sea": {
    scores: { quiet: 82, uncrowded: 73, daylight: 58, seating: 75 }, weekendPenalty: 13,
    confidence: 63, bestTime: "工作日上午",
    evidence: "老店空间具有低声量潜力，光线因座位不同而波动。",
    sourceStatus: "研究核实中",
  },
};

const POSITIVE_VALUES = {
  noise: new Set(["quiet_working"]),
  crowding: new Set(["low", "uncrowded"]),
  daylight: new Set(["strong", "window_facing"]),
  seating: new Set(["comfortable_work_seating", "window_and_garden"]),
  outlets: new Set([true]),
  outdoor_seating: new Set([true]),
  workspace: new Set([true, "focus_work", "suitable"]),
  call_environment: new Set([true, "suitable"]),
};

const NEGATIVE_VALUES = {
  noise: new Set(["social_loud"]),
  crowding: new Set(["afternoon_high", "near_full_after_13", "seasonal_high", "weekday_before_09_full"]),
  daylight: new Set(["weak", false]),
  seating: new Set(["limited", false]),
  outlets: new Set([false]),
  outdoor_seating: new Set([false]),
  workspace: new Set([false, "unsuitable"]),
  call_environment: new Set([false, "unsuitable"]),
  size: new Set(["small"]),
};

function requestedDimensions(request) {
  const weights = new Map((TASK_DIMENSIONS[request.task.type] ?? TASK_DIMENSIONS.other).map((field) => [field, 1]));
  for (const preference of request.soft_preferences) {
    weights.set(preference.field, Math.max(weights.get(preference.field) ?? 0, PRIORITY_WEIGHTS[preference.priority]));
  }
  for (const constraint of request.hard_constraints) weights.set(constraint.field, 5);
  return weights;
}

function sensoryWeights(request) {
  const weights = { ...(TASK_REFERENCE_WEIGHTS[request.task.type] ?? TASK_REFERENCE_WEIGHTS.other) };
  for (const preference of request.soft_preferences) {
    for (const dimension of FIELD_TO_SENSORY_DIMENSIONS[preference.field] ?? []) {
      weights[dimension] = Math.max(weights[dimension], PREFERENCE_WEIGHT_FLOORS[preference.priority]);
    }
  }
  for (const constraint of request.hard_constraints) {
    for (const dimension of FIELD_TO_SENSORY_DIMENSIONS[constraint.field] ?? []) {
      weights[dimension] = Math.max(weights[dimension], 180);
    }
  }
  return weights;
}

function visitTimeBand(arrivalAt) {
  if (!arrivalAt) return "weekdayAfternoon";
  const date = new Date(arrivalAt);
  if (Number.isNaN(date.getTime())) return "weekdayAfternoon";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return "weekend";
  return Number(parts.hour) < 12 ? "weekdayMorning" : "weekdayAfternoon";
}

function adjustedSensoryScores(reference, arrivalAt) {
  const band = visitTimeBand(arrivalAt);
  const change = band === "weekdayMorning" ? 6 : band === "weekend" ? -reference.weekendPenalty : 0;
  return {
    ...reference.scores,
    quiet: Math.max(0, Math.min(100, reference.scores.quiet + Math.round(change * 0.7))),
    uncrowded: Math.max(0, Math.min(100, reference.scores.uncrowded + change)),
  };
}

export function getSensoryReferenceProfile(placeId, arrivalAt = null) {
  const reference = EDITORIAL_SENSORY_REFERENCES[placeId];
  if (!reference) return null;
  return {
    profile_version: SENSORY_REFERENCE_PROFILE_VERSION,
    confidence: reference.confidence,
    best_time: reference.bestTime,
    evidence: reference.evidence,
    source_status: reference.sourceStatus,
    display_scores: adjustedSensoryScores(reference, arrivalAt),
  };
}

function sensoryReferenceScore(placeId, request) {
  const profile = getSensoryReferenceProfile(placeId, request.time.arrival_at);
  if (!profile) return null;
  const weights = sensoryWeights(request);
  const scores = profile.display_scores;
  const weightTotal = SENSORY_DIMENSIONS.reduce((total, dimension) => total + weights[dimension], 0);
  return Math.round(SENSORY_DIMENSIONS.reduce(
    (total, dimension) => total + scores[dimension] * weights[dimension],
    0,
  ) / weightTotal);
}

function relevantRecords(placeId, field, store) {
  return store.evidence.filter((record) => (
    record.place_id === placeId
    && record.attribute === field
    && FACTUAL_STATUSES.has(record.epistemic_status)
    && record.publishability !== "not_factual"
  ));
}

function evidenceOutcome(field, records) {
  if (records.length === 0) return "unknown";
  if (records.some((record) => record.conflict_status !== "none")) return "unknown";

  const values = records.map((record) => record.normalized_value);
  const positive = values.some((value) => POSITIVE_VALUES[field]?.has(value));
  const negative = values.some((value) => NEGATIVE_VALUES[field]?.has(value)
    || (field === "size" && typeof value === "number" && value < 40));
  if (positive && !negative) return "matched";
  if (negative && !positive) return "not_matched";

  if (field === "interior" && values.some((value) => typeof value === "string" && value.length > 0)) {
    return "matched";
  }
  return "unknown";
}

function retrievalEntryByPlace(retrieval) {
  return new Map([
    ...retrieval.candidates.map((candidate) => [candidate.place.place_id, candidate]),
    ...retrieval.rejected.map((entry) => [entry.place_id, {
      eligibility: "rejected",
      hard_constraint_results: entry.results,
    }]),
  ]);
}

function hardOutcome(results) {
  if (results.some((result) => result.status === "fail")) return "not_matched";
  if (results.some((result) => result.status === "unknown")) return "unknown";
  return results.length > 0 ? "matched" : null;
}

export function scoreExplorationPlaces(request, retrieval, store) {
  if (!retrieval || retrieval.status === "out_of_scope") return [];
  const weights = requestedDimensions(request);
  const entryByPlace = retrievalEntryByPlace(retrieval);
  const constraintFields = new Map(request.hard_constraints.map((constraint) => [constraint.constraint_id, constraint.field]));

  return store.places.map((place) => {
    const retrievalEntry = entryByPlace.get(place.place_id) ?? {
      eligibility: "rejected",
      hard_constraint_results: [],
    };
    const resultsByField = new Map();
    for (const result of retrievalEntry.hard_constraint_results ?? []) {
      const field = constraintFields.get(result.constraint_id);
      if (!field) continue;
      resultsByField.set(field, [...(resultsByField.get(field) ?? []), result]);
    }

    const matchedAttributes = [];
    const notMatchedAttributes = [];
    const unknownAttributes = [];
    const evidenceIds = new Set();

    for (const [field] of weights) {
      const records = relevantRecords(place.place_id, field, store);
      records.forEach((record) => evidenceIds.add(record.evidence_id));
      const hardResults = resultsByField.get(field) ?? [];
      hardResults.flatMap((result) => result.evidence_ids).forEach((evidenceId) => evidenceIds.add(evidenceId));
      const outcome = hardOutcome(hardResults) ?? evidenceOutcome(field, records);
      if (outcome === "matched") {
        matchedAttributes.push(field);
      } else if (outcome === "not_matched") {
        notMatchedAttributes.push(field);
      } else {
        unknownAttributes.push(field);
      }
    }

    let score = sensoryReferenceScore(place.place_id, request);
    if (score !== null && retrievalEntry.eligibility === "uncertain") score = Math.min(score, 64);
    if (score !== null && retrievalEntry.eligibility === "rejected") score = Math.min(score, 29);

    return {
      place_id: place.place_id,
      score,
      eligibility: retrievalEntry.eligibility,
      matched_attributes: matchedAttributes,
      not_matched_attributes: notMatchedAttributes,
      unknown_attributes: unknownAttributes,
      evidence_ids: [...evidenceIds],
      hard_constraint_results: retrievalEntry.hard_constraint_results ?? [],
    };
  });
}

export function explorationScoreBucket(score) {
  if (score === null) return "unverified";
  if (score < 25) return "0_24";
  if (score < 50) return "25_49";
  if (score < 75) return "50_74";
  return "75_100";
}
