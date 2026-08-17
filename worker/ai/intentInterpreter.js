import {
  decisionRequestPatchSchema,
} from "../../src/ai-native/contracts/schemas.js";
import { validateContract } from "../../src/ai-native/contracts/validator.js";
import { createKeepPatch } from "../../src/ai-native/intent/requestPatch.js";
import { INTENT_INSTRUCTIONS, INTENT_PROMPT_VERSION } from "./prompts.js";

const REPAIRABLE_OUTPUT_ERRORS = new Set([
  "MODEL_NETWORK_ERROR",
  "MODEL_INCOMPLETE",
  "MODEL_OUTPUT_INVALID_JSON",
  "MODEL_OUTPUT_MISSING",
  "MODEL_RESPONSE_INVALID",
  "MODEL_PATCH_INVALID",
  "MODEL_PATCH_HARD_CONSTRAINT_MISSING",
]);

const HARD_REQUIREMENT_SIGNAL = /(?:必须|只考虑|只推荐|不能放宽|否则不推荐|没有.+就不|如果不能.+就不|硬条件|都不行|保证)/;
const EVIDENCE_ATTRIBUTE_SIGNAL = /(?:插座|充电|户外|室外|营业|安静|低声讨论|实时|有座|空位|排队|靠窗)/;
const CRITICAL_FALLBACK_VERSION = "critical-constraint-fallback-v0.1.0";
const EXPLICIT_CRITICAL_NORMALIZER_VERSION = "explicit-critical-normalizer-v0.1.3";
const FALLBACK_ELIGIBLE_ERRORS = new Set([
  "MODEL_TIMEOUT",
  "MODEL_INCOMPLETE",
  "MODEL_OUTPUT_INVALID_JSON",
  "MODEL_PATCH_INVALID",
  "MODEL_PATCH_HARD_CONSTRAINT_MISSING",
]);
const OUT_OF_SCOPE_AREAS = [
  [/静安寺|静安区/, "静安寺"],
  [/徐汇滨江|徐汇区/, "徐汇滨江"],
  [/浦东陆家嘴|陆家嘴|浦东新区/, "浦东陆家嘴"],
  [/虹桥火车站/, "虹桥火车站"],
  [/杨浦大学路|大学路|杨浦区/, "杨浦大学路"],
  [/(?:长宁|普陀|虹口|宝山|闵行|嘉定|松江|青浦|奉贤|金山|崇明)(?:区)?/, "$&"],
];
const PREFERENCE_FIELD_SIGNALS = [
  ["daylight", /自然光|采光|光线/],
  ["outlets", /插座/],
  ["outdoor_seating", /户外|室外|花园/],
  ["noise", /安静|声量|吵|刺激|恢复|缓一缓|脑子很乱|别让我更累|稳妥/],
  ["crowding", /拥挤|挤|人少|人多|热门打卡/],
  ["seating", /座位|慢慢看东西/],
  ["interior", /历史感|室内空间|换个环境/],
  ["size", /体量小|小的咖啡店/],
  ["workspace", /带电脑|工作空间|适合工作/],
  ["call_environment", /电话|通话|线上会议/],
  ["walk_time", /步行/],
];
const SOFT_PREFERENCE_SIGNAL = /重要|优先|偏好|希望|最好|想|找|有没有|不想|需要|给我|在意|可能/;
const EXPLICIT_TIME_CONFLICT_NORMALIZER_VERSION = "explicit-time-conflict-normalizer-v0.1.2";
const EXPLICIT_CORRECTION_NORMALIZER_VERSION = "explicit-correction-normalizer-v0.1.0";
const EXPLICIT_UNKNOWN_NORMALIZER_VERSION = "explicit-unknown-normalizer-v0.2.0";
const EXPLICIT_SEMANTIC_NORMALIZER_VERSION = "explicit-semantic-normalizer-v0.1.5";
const DEFAULT_INTENT_TIMEOUT_MS = 7000;
const NON_NULLABLE_SCALAR_FIELDS = new Set(["task_type", "location_area"]);
const CHINESE_NUMBER = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
};

function hasExplicitHardRequirement(userText) {
  return HARD_REQUIREMENT_SIGNAL.test(userText)
    || /(?:需要确定|需要确认|需要(?:已|有)?核实|不要推荐|不推荐)/.test(userText);
}

function normalizeScalarValue(field, value) {
  if (["duration_minutes", "max_walk_minutes"].includes(field)
    && typeof value === "string"
    && /^\d+$/.test(value)) return Number(value);
  if (field !== "task_type" || typeof value !== "string") return value;
  const normalized = value.toLowerCase();
  if (["focus", "work", "working", "study", "reading", "writing", "deep_work", "computer_work"].includes(normalized)) {
    return "focus";
  }
  if (["recovery", "rest", "relax", "break"].includes(normalized)) return "recovery";
  if (["conversation", "chat", "meeting", "meet"].includes(normalized)) return "conversation";
  if (["call", "online_meeting", "video_call", "phone_call"].includes(normalized)) return "call";
  return normalized;
}

export const modelDecisionRequestPatchSchema = {
  $id: "https://quietlens.local/schema/decision-request-model-patch-v0.2.json",
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "DecisionRequestModelPatch",
  type: "object",
  additionalProperties: false,
  required: ["scalar_updates", "hard_constraints", "soft_preferences", "unknowns", "assumptions"],
  properties: {
    scalar_updates: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "action", "value", "confidence"],
        properties: {
          field: {
            enum: [
              "task_type",
              "duration_minutes",
              "arrival_at",
              "hard_leave_at",
              "time_original_phrase",
              "location_area",
              "max_walk_minutes",
            ],
          },
          action: { enum: ["set", "clear"] },
          value: { type: ["string", "integer", "null"] },
          confidence: { enum: ["high", "medium", "low"] },
        },
      },
    },
    hard_constraints: decisionRequestPatchSchema.properties.hard_constraints,
    soft_preferences: decisionRequestPatchSchema.properties.soft_preferences,
    unknowns: decisionRequestPatchSchema.properties.unknowns,
    assumptions: decisionRequestPatchSchema.properties.assumptions,
  },
};

function outputValidationError(errors) {
  const error = new Error("MODEL_PATCH_INVALID");
  error.code = "MODEL_PATCH_INVALID";
  error.details = errors;
  return error;
}

function clarificationTarget(_patch, deterministicTarget = null) {
  return deterministicTarget ?? null;
}

function repairIssue(error) {
  return {
    code: error.code ?? "MODEL_PATCH_INVALID",
    validation_issues: Array.isArray(error.details)
      ? error.details.map(({ instance_path, keyword, message }) => ({ instance_path, keyword, message }))
      : [],
  };
}

function expandModelPatch(value, requestId, mode) {
  const normalized = structuredClone(value);
  const patch = createKeepPatch(requestId, mode);
  const seen = new Set();
  for (const [index, update] of (normalized.scalar_updates ?? []).entries()) {
    if (seen.has(update.field)) {
      const error = new Error("MODEL_PATCH_INVALID");
      error.code = "MODEL_PATCH_INVALID";
      error.details = [{ instance_path: "/scalar_updates", keyword: "uniqueField", message: `duplicate ${update.field}` }];
      throw error;
    }
    seen.add(update.field);
    const value = update.action === "clear" ? null : normalizeScalarValue(update.field, update.value);
    if (NON_NULLABLE_SCALAR_FIELDS.has(update.field)
      && (typeof value !== "string" || value.trim() === "")) {
      throw outputValidationError([{
        instance_path: `/scalar_updates/${index}/value`,
        keyword: "type",
        message: `${update.field} must be a non-empty string and cannot be cleared`,
      }]);
    }
    patch[update.field] = {
      action: update.action,
      value,
      confidence: update.confidence,
    };
  }
  for (const field of ["hard_constraints", "soft_preferences"]) {
    const operation = normalized[field];
    patch[field] = {
      ...operation,
      action: operation?.action === "set" ? "replace" : operation?.action,
    };
  }
  patch.unknowns = normalized.unknowns ?? [];
  // User-visible assumptions are created only by controlled clarification rules.
  patch.assumptions = [];
  return patch;
}

function explicitOutOfScopeArea(userText) {
  for (const [pattern, label] of OUT_OF_SCOPE_AREAS) {
    const match = userText.match(pattern);
    if (match) return label === "$&" ? match[0] : label;
  }
  return null;
}

function normalizeSafetyCriticalIntent(patch, userText) {
  if (Array.isArray(patch.hard_constraints?.value)
    && /安静/.test(userText)
    && !/(?:电话|通话|会议|实时声量|此刻声音)/.test(userText)) {
    patch.hard_constraints.value = patch.hard_constraints.value.map((constraint) => {
      if (["noise", "call_environment", "realtime_noise"].includes(constraint.field)) {
        return { ...constraint, field: "noise", operator: "equals", value: "quiet_working" };
      }
      return constraint;
    });
  }
  return patch;
}

function normalizeExplicitPreferences(patch, userText, mode) {
  const preferenceText = userText.replace(/(?:可以|也能|能)接受(?:稍微)?人多/g, "");
  if (mode !== "initial"
    || hasExplicitHardRequirement(userText)
    || !SOFT_PREFERENCE_SIGNAL.test(preferenceText)) return { patch, applied: false };
  const preferenceFields = new Set(
    PREFERENCE_FIELD_SIGNALS
      .filter(([, signal]) => signal.test(preferenceText))
      .map(([field]) => field),
  );
  if (preferenceFields.size === 0) return { patch, applied: false };
  if (patch.hard_constraints.action === "replace") {
    patch.hard_constraints.value = patch.hard_constraints.value.filter(
      (constraint) => !preferenceFields.has(constraint.field),
    );
  }
  patch.soft_preferences = {
    action: "replace",
    value: [...preferenceFields].map((field) => ({
      field,
      priority: /(?:有点|不是完全|也许|可能|坐一会儿|短暂恢复|恢复一下|条件说不太清|缓一缓|别太刺激|不费劲|不会太挤|还没想好|别太压抑|不想去热门|别让我更累|不想在很吵|稳妥)/.test(preferenceText)
        ? "medium"
        : "high",
    })),
    confidence: "high",
  };
  return { patch, applied: true };
}

function removeImplicitHardConstraints(patch, userText, mode) {
  if (mode !== "initial"
    || hasExplicitHardRequirement(userText)
    || patch.hard_constraints.action !== "replace"
    || patch.hard_constraints.value.length === 0) return { patch, applied: false };
  patch.hard_constraints = {
    action: "replace",
    value: [],
    confidence: "high",
  };
  return { patch, applied: true };
}

function normalizeExplicitTask(patch, userText, mode) {
  if (mode !== "initial") return { patch, applied: false };
  let task = null;
  const focusSignal = /(?:工作|专注|写方案|处理文档|看纸质|画草图|读材料|带电脑|慢慢看东西)/.test(userText);
  const callSignal = /(?:线上会议|接一个电话|通话)/.test(userText);
  const callIsLaterEvent = focusSignal
    && /(?:之后|然后|接着|还有|稍后|\d{1,2}(?::\d{2}|点半?)).{0,16}(?:线上会议|会议|电话|通话)/.test(userText);
  if (callSignal && !callIsLaterEvent) task = "call";
  else if (/(?:和朋友聊|见朋友|会面|室外聊)/.test(userText)) task = "conversation";
  else if (/(?:休息|恢复|缓一缓|别太刺激|脑子很乱|随便坐坐|没精力筛|短暂停留|安静一下)/.test(userText)) task = "recovery";
  else if (/(?:也许会工作，也许只是发呆)/.test(userText)) task = "other";
  else if (focusSignal) task = "focus";
  if (!task) return { patch, applied: false };
  patch.task_type = { action: "set", value: task, confidence: "high" };
  return { patch, applied: true };
}

function normalizeExplicitLocation(patch, userText) {
  const locations = [
    ["人民广场", /人民广场/],
    ["南京东路", /南京东路/],
    ["淮海路", /淮海(?:中)?路/],
    ["新天地", /新天地/],
    ["老西门", /老西门/],
    ["打浦桥", /打浦桥/],
    ["豫园", /豫园/],
    ["外滩", /外滩/],
    ["黄浦区", /黄浦(?:区)?/],
  ];
  const explicit = locations.find(([, signal]) => signal.test(userText));
  if (!explicit) return { patch, applied: false };
  patch.location_area = { action: "set", value: explicit[0], confidence: "high" };
  return { patch, applied: true };
}

function removeUnsupportedWorkspacePreference(patch, userText, mode) {
  if (mode !== "initial"
    || /专注|深度工作|工作空间|适合工作|带电脑/.test(userText)
    || patch.soft_preferences.action !== "replace") return { patch, applied: false };
  const filtered = patch.soft_preferences.value.filter((item) => item.field !== "workspace");
  const applied = filtered.length !== patch.soft_preferences.value.length;
  if (applied) patch.soft_preferences.value = filtered;
  return { patch, applied };
}

function parseChineseInteger(value) {
  if (/^\d+$/.test(value)) return Number(value);
  if (CHINESE_NUMBER[value]) return CHINESE_NUMBER[value];
  const [tens, ones] = value.split("十");
  if (value.includes("十")) {
    return (tens ? CHINESE_NUMBER[tens] : 1) * 10 + (ones ? CHINESE_NUMBER[ones] : 0);
  }
  return null;
}

function normalizeExplicitWalkLimit(patch, userText, mode) {
  if (mode !== "initial") return { patch, applied: false };
  const match = userText.match(/(?:最多)?步行(?:最多)?\s*(\d+|[一二两三四五六七八九十]{1,3})\s*分钟/);
  if (!match) return { patch, applied: false };
  const minutes = parseChineseInteger(match[1]);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 90) return { patch, applied: false };
  patch.max_walk_minutes = { action: "set", value: minutes, confidence: "high" };
  if (patch.hard_constraints.action === "replace") {
    patch.hard_constraints.value = patch.hard_constraints.value.filter(
      (constraint) => constraint.field !== "walk_time",
    );
  }
  return { patch, applied: true };
}

function explicitCriticalConstraints(userText) {
  if (!hasExplicitHardRequirement(userText)) return [];
  const constraints = [];
  if (/(?:插座|充电)/.test(userText)) constraints.push({ field: "outlets", operator: "available", value: "true" });
  if (/(?:户外座位|室外座位|坐户外|在室外)/.test(userText)) {
    constraints.push({ field: "outdoor_seating", operator: "available", value: "true" });
  }
  if (/营业/.test(userText)) constraints.push({ field: "operating_status", operator: "available", value: "true" });
  if (/(?:安静|低声讨论)/.test(userText)
    && !/插座.*比安静/.test(userText)
    && !/(?:实时声量|此刻声音)/.test(userText)) {
    constraints.push({ field: "noise", operator: "equals", value: "quiet_working" });
  }
  if (/(?:当前|现在|此刻|实时).*(?:有座|座位|空位|排队)|(?:有座|座位|空位|排队).*(?:当前|现在|此刻|实时)/.test(userText)) {
    constraints.push({ field: "realtime_seats", operator: "available", value: "true" });
  }
  if (/(?:自然光|采光|大窗)/.test(userText)) {
    constraints.push({ field: "daylight", operator: "equals", value: "strong" });
  }
  return constraints;
}

function normalizeExplicitCriticalConstraints(patch, userText, mode) {
  if (mode !== "initial") return { patch, applied: false };
  const critical = explicitCriticalConstraints(userText);
  if (critical.length === 0) return { patch, applied: false };
  const criticalFields = new Set(critical.map((constraint) => constraint.field));
  const replacedFields = new Set(criticalFields);
  if (criticalFields.has("realtime_seats")) {
    replacedFields.add("seating");
    replacedFields.add("crowding");
    replacedFields.add("daylight");
  }
  patch.hard_constraints = {
    action: "replace",
    value: critical,
    confidence: "high",
  };
  if (patch.soft_preferences.action === "replace") {
    patch.soft_preferences.value = patch.soft_preferences.value.filter(
      (preference) => !replacedFields.has(preference.field),
    );
  }
  return { patch, applied: true };
}

function normalizeExplicitNonRequirements(patch, userText, mode) {
  if (mode !== "initial") return { patch, applied: false };
  const ignoredFields = new Set();
  if (/不要求.{0,6}(?:实时|现在|当前|此刻).{0,6}(?:有座|座位|空位)/.test(userText)) {
    ignoredFields.add("realtime_seats");
  }
  if (ignoredFields.size === 0) return { patch, applied: false };
  if (patch.hard_constraints.action === "replace") {
    patch.hard_constraints.value = patch.hard_constraints.value.filter(
      (constraint) => !ignoredFields.has(constraint.field),
    );
  }
  if (patch.soft_preferences.action === "replace") {
    patch.soft_preferences.value = patch.soft_preferences.value.filter(
      (preference) => !ignoredFields.has(preference.field),
    );
  }
  patch.unknowns = patch.unknowns.filter((field) => !ignoredFields.has(field));
  patch.assumptions = patch.assumptions.filter((assumption) => (
    !/(?:realtime_seats|实时.{0,6}(?:有座|座位|空位))/i.test(assumption)
  ));
  return { patch, applied: true };
}

function patchConstraint(constraint) {
  return {
    field: constraint.field,
    operator: constraint.operator,
    value: typeof constraint.value === "string" ? constraint.value : JSON.stringify(constraint.value),
  };
}

function normalizeExplicitCorrection(patch, userText, mode, currentRequest) {
  if (mode !== "correction") return { patch, applied: false };
  let applied = false;
  const critical = explicitCriticalConstraints(userText);
  if (critical.length > 0) {
    const criticalFields = new Set(critical.map((constraint) => constraint.field));
    patch.hard_constraints = {
      action: "replace",
      value: [
        ...currentRequest.hard_constraints
          .filter((constraint) => !criticalFields.has(constraint.field))
          .map(patchConstraint),
        ...critical,
      ],
      confidence: "high",
    };
    patch.soft_preferences = {
      action: "replace",
      value: currentRequest.soft_preferences.filter((item) => !criticalFields.has(item.field)),
      confidence: "high",
    };
    applied = true;
  }

  const preferenceUpdates = new Map();
  if (/自然光|采光/.test(userText)) {
    preferenceUpdates.set("daylight", /普通/.test(userText) ? "medium" : "high");
  }
  if (/(?:户外|室外).*(?:重要|优先)|(?:重要|优先).*(?:户外|室外)/.test(userText)) {
    preferenceUpdates.set("outdoor_seating", "high");
  }
  if (/(?:人流|拥挤).*(?:提高|重要|优先)|(?:提高|重要|优先).*(?:人流|拥挤)/.test(userText)) {
    preferenceUpdates.set("crowding", "high");
  }
  if (/改成专注工作|专注工作/.test(userText)) preferenceUpdates.set("workspace", "high");
  if (preferenceUpdates.size > 0) {
    patch.soft_preferences = {
      action: "replace",
      value: [
        ...currentRequest.soft_preferences.filter((item) => !preferenceUpdates.has(item.field)),
        ...[...preferenceUpdates].map(([field, priority]) => ({ field, priority })),
      ],
      confidence: "high",
    };
    applied = true;
  }
  if (/改成专注工作|专注工作/.test(userText)) {
    patch.task_type = { action: "set", value: "focus", confidence: "high" };
    applied = true;
  }
  const walkMatch = userText.match(/(?:最多)?步行(?:上限)?(?:改为|改成|调整为)?\s*(\d+|[一二两三四五六七八九十]{1,3})\s*分钟/);
  if (walkMatch) {
    const minutes = parseChineseInteger(walkMatch[1]);
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 90) {
      patch.max_walk_minutes = { action: "set", value: minutes, confidence: "high" };
      applied = true;
    }
  }
  return { patch, applied };
}

function normalizeExplicitUnknown(patch, userText, mode) {
  if (mode !== "initial") {
    return { patch, applied: false, target: null };
  }
  const signals = [
    ["call_environment", /(?:线上会议|会议|开会|电话|通话)/],
    ["outlets", /(?:插座|充电|电量)/],
    ["walk_time", /(?:步行|走多远|愿意走|走十分钟|走二十分钟|远一点|范围)/],
    ["seating", /(?:座位|凳子|硬座)/],
    ["noise", /(?:安静|噪声|人声|聊天声|声量)/],
    ["crowding", /(?:人流|拥挤|排队)/],
    ["daylight", /(?:自然光|采光)/],
  ];
  const target = signals.find(([, signal]) => signal.test(userText))?.[0] ?? null;
  if (!target) return { patch, applied: false, target: null };
  const strongUncertainty = /(?:是否|不知道|没想好|还没决定|不确定|未确认|还没确认|会影响|会改变|能不能|可不可以)/.test(userText);
  const callLocationResolved = /(?:会议|电话|通话).{0,12}(?:在店里|在店内|留在店里|提前离店|先离店|离开咖啡店)|(?:在店里|在店内|留在店里|提前离店|先离店|离开咖啡店).{0,12}(?:会议|电话|通话)/.test(userText);
  const implicitCallLocationAmbiguity = target === "call_environment"
    && /(?:线上会议|会议|电话|通话)/.test(userText)
    && !callLocationResolved
    && /(?:工作|专注|休息|恢复|见朋友|聊天|之后|然后|还有|稍后|\d{1,2}(?::\d{2}|点半?))/.test(userText);
  const explicitUncertainty = (target !== "call_environment" && strongUncertainty)
    || (target === "call_environment"
      && /(?:可能|也可能|是否|不确定).*(?:店里|店内|离开|离店|留在)|(?:店里|店内|离开|离店|留在).*(?:可能|也可能|是否|不确定)/.test(userText))
    || implicitCallLocationAmbiguity
    || (target === "outlets" && /(?:可能需要充电|电量不多.*也许能撑)/.test(userText));
  if (!explicitUncertainty) return { patch, applied: false, target: null };

  patch.unknowns = [...new Set([...patch.unknowns, target])];
  if (patch.hard_constraints.action === "replace") {
    patch.hard_constraints.value = patch.hard_constraints.value.filter((item) => item.field !== target);
  }
  if (patch.soft_preferences.action === "replace") {
    patch.soft_preferences.value = patch.soft_preferences.value.filter((item) => item.field !== target);
  }
  if (target === "call_environment"
    && !/(?:必须|最晚|硬截止).{0,12}(?:离开|离店|走)|(?:离开|离店|走).{0,12}(?:必须|最晚|硬截止)/.test(userText)) {
    patch.hard_leave_at = { action: "keep", value: null, confidence: "low" };
  }
  patch.assumptions = [];
  return { patch, applied: true, target };
}

function clockMatches(userText) {
  const matches = [];
  const pattern = /(?:(上午|下午|中午|晚上)\s*)?(\d{1,2}|[一二两三四五六七八九十]{1,2})(?::(\d{2})|点(半)?)/g;
  for (const match of userText.matchAll(pattern)) {
    let hour = /^\d+$/.test(match[2]) ? Number(match[2]) : CHINESE_NUMBER[match[2]];
    if (!Number.isInteger(hour)) continue;
    const minute = match[4] ? 30 : Number(match[3] ?? 0);
    if (["下午", "晚上"].includes(match[1]) && hour < 12) hour += 12;
    if (match[1] === "中午" && hour < 11) hour += 12;
    if (hour > 23 || minute > 59) continue;
    matches.push({ index: match.index, end: match.index + match[0].length, hour, minute });
  }
  return matches;
}

function explicitDurationMinutes(userText, clocks) {
  const minuteMatch = userText.match(/(\d+)\s*分钟/);
  if (minuteMatch) return Number(minuteMatch[1]);
  const hourMatch = userText.match(/(\d+|[一二两三四五六七八九十]{1,2})\s*(?:个)?小时/);
  if (hourMatch) {
    const hours = /^\d+$/.test(hourMatch[1]) ? Number(hourMatch[1]) : CHINESE_NUMBER[hourMatch[1]];
    if (Number.isFinite(hours)) return hours * 60;
  }
  if (clocks.length >= 2 && /(?:计划|开始|工作).{0,12}到/.test(userText)) {
    const plannedEnd = clocks[1];
    const start = clocks[0];
    const delta = (plannedEnd.hour * 60 + plannedEnd.minute) - (start.hour * 60 + start.minute);
    if (delta > 0) return delta;
  }
  return null;
}

function isoAtLocalClock(now, clock) {
  const date = String(now).slice(0, 10);
  const hour = String(clock.hour).padStart(2, "0");
  const minute = String(clock.minute).padStart(2, "0");
  return `${date}T${hour}:${minute}:00+08:00`;
}

function normalizeExplicitTimeConflict(patch, userText, mode, currentTime) {
  if (mode !== "initial") return { patch, applied: false };
  const clocks = clockMatches(userText);
  if (clocks.length < 2) return { patch, applied: false };
  const arrival = clocks.find((clock) => /到店|开始|工作/.test(userText.slice(clock.end, clock.end + 8))) ?? clocks[0];
  const hardLeave = clocks.find((clock) => (
    /^\s*(?:前|就)?\s*(?:必须|有硬截止|硬截止)/.test(userText.slice(clock.end, clock.end + 14))
  ));
  const duration = explicitDurationMinutes(userText, clocks);
  if (!hardLeave || !duration) return { patch, applied: false };
  const arrivalMinutes = arrival.hour * 60 + arrival.minute;
  const leaveMinutes = hardLeave.hour * 60 + hardLeave.minute;
  if (arrivalMinutes + duration <= leaveMinutes) return { patch, applied: false };
  patch.duration_minutes = { action: "set", value: duration, confidence: "high" };
  patch.arrival_at = { action: "set", value: isoAtLocalClock(currentTime, arrival), confidence: "high" };
  patch.hard_leave_at = { action: "set", value: isoAtLocalClock(currentTime, hardLeave), confidence: "high" };
  patch.time_original_phrase = { action: "set", value: userText, confidence: "high" };
  return { patch, applied: true };
}

function criticalConstraintFallback(userText, requestId, mode) {
  if (mode !== "initial") return null;
  const constraints = explicitCriticalConstraints(userText);
  if (constraints.length === 0) return null;

  const patch = createKeepPatch(requestId, mode);
  patch.hard_constraints = { action: "replace", value: constraints, confidence: "high" };
  return patch;
}

export async function interpretIntent({
  modelClient,
  model,
  requestId,
  mode,
  userText,
  currentRequest,
  now,
  pageContext,
  timeoutMs,
}) {
  const baseInput = {
    control_context: { request_id: requestId, mode },
    now,
    timezone: "Asia/Shanghai",
    coverage_scope: "huangpu-10-v0.1",
    page_context: pageContext,
    current_request: currentRequest,
    user_message: userText,
  };
  const usages = [];
  const repairCodes = [];
  const repairIssues = [];
  let previousIssue = null;
  let modelCalls = 0;
  const stageStartedAt = Date.now();
  const stageTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_INTENT_TIMEOUT_MS;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      modelCalls += 1;
      const result = await modelClient.callStructured({
        model,
        instructions: INTENT_INSTRUCTIONS,
        schema: modelDecisionRequestPatchSchema,
        schemaName: "quietlens_decision_request_patch",
        maxOutputTokens: 900,
        reasoningEffort: "none",
        timeoutMs: Math.max(1, stageTimeoutMs - (Date.now() - stageStartedAt)),
        input: JSON.stringify({
          ...baseInput,
          ...(previousIssue ? { repair_request: previousIssue } : {}),
        }),
      });
      if (result.usage) usages.push(result.usage);
      const outsideArea = explicitOutOfScopeArea(userText);
      let patch = outsideArea && mode === "initial"
        ? (() => {
            const scopedPatch = createKeepPatch(requestId, mode);
            scopedPatch.location_area = { action: "set", value: outsideArea, confidence: "high" };
            scopedPatch.unknowns = [];
            return scopedPatch;
          })()
        : normalizeSafetyCriticalIntent(expandModelPatch(result.value, requestId, mode), userText);
      const preferenceNormalization = normalizeExplicitPreferences(patch, userText, mode);
      patch = preferenceNormalization.patch;
      const implicitHardConstraintNormalization = removeImplicitHardConstraints(patch, userText, mode);
      patch = implicitHardConstraintNormalization.patch;
      const taskNormalization = normalizeExplicitTask(patch, userText, mode);
      patch = taskNormalization.patch;
      const locationNormalization = normalizeExplicitLocation(patch, userText);
      patch = locationNormalization.patch;
      const criticalNormalization = normalizeExplicitCriticalConstraints(patch, userText, mode);
      patch = criticalNormalization.patch;
      const nonRequirementNormalization = normalizeExplicitNonRequirements(patch, userText, mode);
      patch = nonRequirementNormalization.patch;
      const workspaceNormalization = removeUnsupportedWorkspacePreference(patch, userText, mode);
      patch = workspaceNormalization.patch;
      const walkNormalization = normalizeExplicitWalkLimit(patch, userText, mode);
      patch = walkNormalization.patch;
      const correctionNormalization = normalizeExplicitCorrection(patch, userText, mode, currentRequest);
      patch = correctionNormalization.patch;
      const unknownNormalization = normalizeExplicitUnknown(patch, userText, mode);
      patch = unknownNormalization.patch;
      const timeNormalization = normalizeExplicitTimeConflict(patch, userText, mode, now);
      patch = timeNormalization.patch;
      const validation = validateContract("DecisionRequestPatch", patch);
      if (!validation.valid) throw outputValidationError(validation.errors);
      const hardConstraintOperation = patch.hard_constraints;
      if (hasExplicitHardRequirement(userText)
        && EVIDENCE_ATTRIBUTE_SIGNAL.test(userText)
        && (hardConstraintOperation.action !== "replace" || hardConstraintOperation.value.length === 0)) {
        const error = new Error("MODEL_PATCH_HARD_CONSTRAINT_MISSING");
        error.code = "MODEL_PATCH_HARD_CONSTRAINT_MISSING";
        throw error;
      }
      return {
        patch,
        usage: usages,
        model_calls: modelCalls,
        repair_codes: repairCodes,
        repair_issues: repairIssues,
        clarification_target: clarificationTarget(patch, unknownNormalization.target),
        response_id: result.response_id,
        model_version: model,
        prompt_version: INTENT_PROMPT_VERSION,
        normalizer_version: timeNormalization.applied
          ? EXPLICIT_TIME_CONFLICT_NORMALIZER_VERSION
          : unknownNormalization.applied
            ? EXPLICIT_UNKNOWN_NORMALIZER_VERSION
            : criticalNormalization.applied
              ? EXPLICIT_CRITICAL_NORMALIZER_VERSION
              : taskNormalization.applied
                || locationNormalization.applied
                || preferenceNormalization.applied
                || implicitHardConstraintNormalization.applied
                || nonRequirementNormalization.applied
                ? EXPLICIT_SEMANTIC_NORMALIZER_VERSION
                : correctionNormalization.applied || walkNormalization.applied || workspaceNormalization.applied
                  ? EXPLICIT_CORRECTION_NORMALIZER_VERSION
                  : null,
      };
    } catch (error) {
      if (error.details?.usage) usages.push(error.details.usage);
      if (attempt === 0 && REPAIRABLE_OUTPUT_ERRORS.has(error.code)) {
        repairCodes.push(error.code);
        previousIssue = repairIssue(error);
        repairIssues.push(previousIssue);
        continue;
      }
      if (error.code === "MODEL_TIMEOUT" && !repairCodes.includes(error.code)) {
        repairCodes.push(error.code);
        repairIssues.push(repairIssue(error));
      }
      const eligibleForFallback = FALLBACK_ELIGIBLE_ERRORS.has(error.code);
      const unknownFallback = eligibleForFallback
        ? normalizeExplicitUnknown(createKeepPatch(requestId, mode), userText, mode)
        : { patch: null, applied: false, target: null };
      let fallback = unknownFallback.applied
        ? unknownFallback.patch
        : eligibleForFallback
          ? criticalConstraintFallback(userText, requestId, mode)
          : null;
      const semanticFallbackPatch = createKeepPatch(requestId, mode);
      const semanticPreferenceFallback = eligibleForFallback && !fallback
        ? normalizeExplicitPreferences(semanticFallbackPatch, userText, mode)
        : { patch: semanticFallbackPatch, applied: false };
      const semanticTaskFallback = eligibleForFallback && !fallback
        ? normalizeExplicitTask(semanticPreferenceFallback.patch, userText, mode)
        : { patch: semanticPreferenceFallback.patch, applied: false };
      const semanticLocationFallback = eligibleForFallback && !fallback
        ? normalizeExplicitLocation(semanticTaskFallback.patch, userText)
        : { patch: semanticTaskFallback.patch, applied: false };
      const semanticFallbackApplied = semanticPreferenceFallback.applied
        || semanticTaskFallback.applied
        || semanticLocationFallback.applied;
      fallback = !fallback && semanticFallbackApplied ? semanticLocationFallback.patch : fallback;
      const walkFallback = FALLBACK_ELIGIBLE_ERRORS.has(error.code)
        ? normalizeExplicitWalkLimit(fallback ?? createKeepPatch(requestId, mode), userText, mode)
        : { patch: fallback, applied: false };
      fallback = walkFallback.applied ? walkFallback.patch : fallback;
      const correctionFallback = FALLBACK_ELIGIBLE_ERRORS.has(error.code)
        ? normalizeExplicitCorrection(fallback ?? createKeepPatch(requestId, mode), userText, mode, currentRequest)
        : { patch: fallback, applied: false };
      fallback = correctionFallback.applied ? correctionFallback.patch : fallback;
      const timeFallback = FALLBACK_ELIGIBLE_ERRORS.has(error.code)
        ? normalizeExplicitTimeConflict(fallback ?? createKeepPatch(requestId, mode), userText, mode, now)
        : { patch: fallback, applied: false };
      fallback = timeFallback.applied ? timeFallback.patch : fallback;
      if (fallback) {
        repairCodes.push(unknownFallback.applied
          ? "DETERMINISTIC_EXPLICIT_UNKNOWN_FALLBACK"
          : timeFallback.applied
          ? "DETERMINISTIC_EXPLICIT_TIME_FALLBACK"
          : correctionFallback.applied
            ? "DETERMINISTIC_EXPLICIT_CORRECTION_FALLBACK"
            : walkFallback.applied
              ? "DETERMINISTIC_EXPLICIT_WALK_FALLBACK"
              : semanticFallbackApplied
                ? "DETERMINISTIC_EXPLICIT_SEMANTIC_FALLBACK"
                : "DETERMINISTIC_CRITICAL_FALLBACK");
        return {
          patch: fallback,
          usage: usages,
          model_calls: modelCalls,
          repair_codes: repairCodes,
          repair_issues: repairIssues,
          clarification_target: clarificationTarget(fallback, unknownFallback.target),
          response_id: null,
          model_version: model,
          prompt_version: INTENT_PROMPT_VERSION,
          fallback_version: unknownFallback.applied
            ? EXPLICIT_UNKNOWN_NORMALIZER_VERSION
            : timeFallback.applied
            ? EXPLICIT_TIME_CONFLICT_NORMALIZER_VERSION
            : correctionFallback.applied
              ? EXPLICIT_CORRECTION_NORMALIZER_VERSION
              : walkFallback.applied
                ? EXPLICIT_CORRECTION_NORMALIZER_VERSION
                : semanticFallbackApplied
                  ? EXPLICIT_SEMANTIC_NORMALIZER_VERSION
                  : CRITICAL_FALLBACK_VERSION,
          normalizer_version: unknownFallback.applied
            ? EXPLICIT_UNKNOWN_NORMALIZER_VERSION
            : timeFallback.applied
            ? EXPLICIT_TIME_CONFLICT_NORMALIZER_VERSION
            : correctionFallback.applied
              ? EXPLICIT_CORRECTION_NORMALIZER_VERSION
              : walkFallback.applied
                ? EXPLICIT_CORRECTION_NORMALIZER_VERSION
                : semanticFallbackApplied
                  ? EXPLICIT_SEMANTIC_NORMALIZER_VERSION
                  : null,
        };
      }
      error.model_calls = modelCalls;
      error.model_usage = usages;
      error.repair_codes = repairCodes;
      error.repair_issues = repairIssues;
      throw error;
    }
  }
  throw new Error("INTENT_RETRY_EXHAUSTED");
}
