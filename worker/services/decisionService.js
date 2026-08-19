import { chooseClarification } from "../../src/ai-native/intent/clarification.js";
import { preprocessUserInput } from "../../src/ai-native/intent/inputPreprocessor.js";
import {
  createEmptyDecisionRequest,
  hasTimeWindowConflict,
  mergeDecisionRequestPatch,
} from "../../src/ai-native/intent/requestPatch.js";
import {
  buildPublicDecisionContext,
  retrieveEvidence,
} from "../../src/ai-native/evidence/retrieveEvidence.js";
import {
  renderDeterministicRefusal,
  renderDeterministicSingleCandidate,
  verifyAndRenderDecisionDraft,
} from "../../src/ai-native/decision/verifyAndRender.js";
import { assertContract } from "../../src/ai-native/contracts/validator.js";
import { createModelUsageObservation } from "../../src/ai-native/analytics/decisionCost.js";
import { createDeepSeekResponsesClient, ModelCallError } from "../ai/deepseekResponsesClient.js";
import { interpretIntent } from "../ai/intentInterpreter.js";
import { reasonAboutCandidates } from "../ai/decisionReasoner.js";
import { INTENT_PROMPT_VERSION, REASONER_PROMPT_VERSION } from "../ai/prompts.js";
import { analyticsEvent, emitAnalyticsEvent } from "../analytics/telemetry.js";
import { emitOperationalEvent } from "../observability/runtime.js";

const DEFAULT_INTENT_MODEL = "deepseek-v4-flash";
const DEFAULT_REASONING_MODEL = "deepseek-v4-flash";
const DEFAULT_REASONING_TIMEOUT_MS = 7000;
const TRANSIENT_REASONING_ERRORS = new Set([
  "MODEL_TIMEOUT",
  "MODEL_NETWORK_ERROR",
  "MODEL_INCOMPLETE",
  "MODEL_OUTPUT_INVALID_JSON",
  "MODEL_OUTPUT_MISSING",
  "MODEL_RESPONSE_INVALID",
  "MODEL_DRAFT_INVALID",
]);

function now(env) {
  return typeof env.QUIETLENS_NOW === "function" ? env.QUIETLENS_NOW() : new Date().toISOString();
}

function elapsedMs(startedAt) {
  return Math.max(1, Date.now() - startedAt);
}

function modelClient(env) {
  return env.QUIETLENS_MODEL_CLIENT ?? createDeepSeekResponsesClient(env);
}

function evidenceStore(env) {
  if (!env.QUIETLENS_EVIDENCE_STORE) throw new Error("EVIDENCE_STORE_NOT_CONFIGURED");
  return env.QUIETLENS_EVIDENCE_STORE;
}

async function record(env, input) {
  try {
    await emitAnalyticsEvent(env, analyticsEvent(input));
    return true;
  } catch {
    await emitOperationalEvent(env, {
      severity: "error",
      code: "ANALYTICS_DELIVERY_FAILED",
      requestId: input.requestId,
    });
    return false;
  }
}

async function recordModelUsage(env, {
  sessionId,
  requestId,
  stage,
  operation,
  modelVersion,
  promptVersion,
  modelCalls,
  usage,
}) {
  try {
    const properties = createModelUsageObservation({
      operation,
      modelVersion,
      promptVersion,
      modelCalls,
      usage,
    });
    return record(env, {
      eventName: "model_usage_observed",
      sessionId,
      requestId,
      stage,
      modelVersion,
      promptVersion,
      properties,
    });
  } catch {
    await emitOperationalEvent(env, {
      severity: "error",
      code: "MODEL_USAGE_OBSERVATION_FAILED",
      requestId,
    });
    return false;
  }
}

function citationCount(brief) {
  return brief.candidates.reduce((count, candidate) => (
    count + candidate.fit_reasons.reduce((sum, reason) => sum + reason.evidence_ids.length, 0)
      + candidate.tradeoffs.reduce((sum, reason) => sum + reason.evidence_ids.length, 0)
  ), 0);
}

function publishedResult({ brief, store, retrieval, verification, metrics }) {
  const context = buildPublicDecisionContext(brief, store, retrieval);
  return { brief, context, verification, metrics };
}

async function recordPublished(env, payload, result, workflowStartedAt) {
  const { brief } = result;
  const modelVersion = brief.versions.model;
  const promptVersion = brief.versions.prompt;
  await recordModelUsage(env, {
    sessionId: payload.session_id,
    requestId: brief.request_id,
    stage: "F4",
    operation: "decision_reasoning",
    modelVersion,
    promptVersion,
    modelCalls: result.metrics.model_calls,
    usage: result.metrics.usage,
  });
  await record(env, {
    eventName: "evidence_verification_succeeded",
    sessionId: payload.session_id,
    requestId: brief.request_id,
    stage: "F4",
    modelVersion,
    promptVersion,
    properties: { claim_count: brief.candidates.length, citation_count: citationCount(brief) },
  });
  await record(env, {
    eventName: "decision_published",
    sessionId: payload.session_id,
    requestId: brief.request_id,
    stage: "F4",
    modelVersion,
    promptVersion,
    properties: {
      candidate_count: brief.candidates.length,
      unknown_count: new Set(brief.candidates.flatMap((candidate) => candidate.unknowns)).size,
      total_duration_ms: elapsedMs(workflowStartedAt),
    },
  });
}

async function recordRefused(env, payload, result, workflowStartedAt) {
  const { brief } = result;
  await recordModelUsage(env, {
    sessionId: payload.session_id,
    requestId: brief.request_id,
    stage: "F7",
    operation: "decision_reasoning",
    modelVersion: brief.versions.model,
    promptVersion: brief.versions.prompt,
    modelCalls: result.metrics.model_calls,
    usage: result.metrics.usage,
  });
  await record(env, {
    eventName: "decision_refused",
    sessionId: payload.session_id,
    requestId: brief.request_id,
    stage: "F7",
    modelVersion: brief.versions.model,
    promptVersion: brief.versions.prompt,
    properties: {
      refusal_type: brief.refusal.reason_code,
      hard_constraint_count: brief.request.hard_constraints.length,
      relaxable_field_count: brief.refusal.relaxable_fields.length,
      total_duration_ms: elapsedMs(workflowStartedAt),
    },
  });
}

export async function interpretDecisionRequest(env, payload) {
  const startedAt = Date.now();
  const input = preprocessUserInput(payload.user_text);
  if (!input.valid) {
    const error = new Error(input.error_code);
    error.code = input.error_code;
    throw error;
  }
  const mode = payload.mode === "correction" ? "correction" : "initial";
  const current = mode === "correction"
    ? assertContract("DecisionRequest", payload.current_request)
    : createEmptyDecisionRequest(payload.request_id, payload.page_context?.area ?? "黄浦区");
  const intentModel = env.QL_INTENT_MODEL ?? DEFAULT_INTENT_MODEL;

  await record(env, {
    eventName: "intent_parse_started",
    sessionId: payload.session_id,
    requestId: current.request_id,
    stage: "F1",
    modelVersion: intentModel,
    promptVersion: INTENT_PROMPT_VERSION,
  });
  try {
    const interpreted = await interpretIntent({
      modelClient: modelClient(env),
      model: intentModel,
      requestId: current.request_id,
      mode,
      userText: input.text,
      currentRequest: current,
      now: now(env),
      pageContext: payload.page_context ?? {},
      timeoutMs: Number(env.QL_INTENT_TIMEOUT_MS) || undefined,
    });
    const merged = mergeDecisionRequestPatch(current, interpreted.patch);
    const clarification = chooseClarification(merged.request, {
      alreadyAsked: Boolean(payload.clarification_already_asked),
      preferredTarget: interpreted.clarification_target,
    });
    await record(env, {
      eventName: "intent_parse_succeeded",
      sessionId: payload.session_id,
      requestId: current.request_id,
      stage: "F1",
      modelVersion: interpreted.model_version,
      promptVersion: interpreted.prompt_version,
      properties: { duration_ms: Date.now() - startedAt },
    });
    await recordModelUsage(env, {
      sessionId: payload.session_id,
      requestId: current.request_id,
      stage: "F1",
      operation: mode === "correction" ? "intent_correction" : "intent_initial",
      modelVersion: interpreted.model_version,
      promptVersion: interpreted.prompt_version,
      modelCalls: interpreted.model_calls,
      usage: interpreted.usage,
    });
    return {
      request: merged.request,
      patch: interpreted.patch,
      changes: merged.changes,
      clarification,
      versions: {
        intent_model: interpreted.model_version,
        intent_prompt: interpreted.prompt_version,
        intent_fallback: interpreted.fallback_version ?? null,
        intent_normalizer: interpreted.normalizer_version ?? null,
      },
      metrics: {
        model_calls: interpreted.model_calls,
        usage: interpreted.usage,
        repair_codes: interpreted.repair_codes,
        repair_issues: interpreted.repair_issues,
      },
    };
  } catch (error) {
    const failedUsage = Array.isArray(error.model_usage) ? error.model_usage.filter(Boolean) : [];
    if (error.details?.usage) failedUsage.push(error.details.usage);
    await recordModelUsage(env, {
      sessionId: payload.session_id,
      requestId: current.request_id,
      stage: "F1",
      operation: mode === "correction" ? "intent_correction" : "intent_initial",
      modelVersion: intentModel,
      promptVersion: INTENT_PROMPT_VERSION,
      modelCalls: Number.isSafeInteger(error.model_calls) ? error.model_calls : 0,
      usage: failedUsage,
    });
    await record(env, {
      eventName: "intent_parse_failed",
      sessionId: payload.session_id,
      requestId: current.request_id,
      stage: "F1",
      modelVersion: intentModel,
      promptVersion: INTENT_PROMPT_VERSION,
      errorCode: error.code ?? "INTENT_PARSE_FAILED",
      properties: { duration_ms: Date.now() - startedAt },
    });
    throw error;
  }
}

export async function recommendForDecisionRequest(env, payload, { workflowStartedAt = Date.now() } = {}) {
  const request = assertContract("DecisionRequest", payload.request);
  const reasoningModel = env.QL_REASONING_MODEL ?? DEFAULT_REASONING_MODEL;
  const retrievalStarted = Date.now();
  await record(env, {
    eventName: "retrieval_started",
    sessionId: payload.session_id,
    requestId: request.request_id,
    stage: "F3",
    modelVersion: reasoningModel,
    promptVersion: REASONER_PROMPT_VERSION,
  });
  let store;
  let retrieval;
  try {
    store = evidenceStore(env);
    retrieval = retrieveEvidence(request, store);
    await record(env, {
      eventName: "retrieval_succeeded",
      sessionId: payload.session_id,
      requestId: request.request_id,
      stage: "F3",
      modelVersion: reasoningModel,
      promptVersion: REASONER_PROMPT_VERSION,
      properties: { hit_count: retrieval.candidates.length, duration_ms: elapsedMs(retrievalStarted) },
    });
  } catch (error) {
    await record(env, {
      eventName: "retrieval_failed",
      sessionId: payload.session_id,
      requestId: request.request_id,
      stage: "F3",
      modelVersion: reasoningModel,
      promptVersion: REASONER_PROMPT_VERSION,
      errorCode: error.code ?? "RETRIEVAL_FAILED",
      properties: { duration_ms: elapsedMs(retrievalStarted) },
    });
    error.code = "EVIDENCE_UNAVAILABLE";
    throw error;
  }

  const eligibleCandidateCount = retrieval.candidates.filter((candidate) => candidate.eligibility === "eligible").length;
  const timeConflict = hasTimeWindowConflict(request);
  if (timeConflict || retrieval.status !== "ready" || eligibleCandidateCount === 0) {
    const reasonCode = timeConflict
      ? "time_window_conflict"
      : retrieval.status === "out_of_scope"
      ? "coverage_out_of_scope"
      : retrieval.status === "no_candidates" || eligibleCandidateCount === 0
        ? "hard_constraints_no_result"
        : "insufficient_comparable_candidates";
    const brief = renderDeterministicRefusal({
      request,
      retrieval,
      reasonCode,
      modelVersion: "not-invoked",
      promptVersion: "deterministic-refusal-v0.1.0",
    });
    const result = publishedResult({
      brief,
      store,
      retrieval,
      verification: { valid: true, issues: [] },
      metrics: { model_calls: 0, usage: [], verification_repair_codes: [] },
    });
    await recordRefused(env, payload, result, workflowStartedAt);
    return result;
  }

  if (eligibleCandidateCount === 1) {
    const verification = renderDeterministicSingleCandidate({ request, retrieval, store });
    const brief = verification.brief;
    const result = publishedResult({
      brief,
      store,
      retrieval,
      verification,
      metrics: { model_calls: 0, usage: [], verification_repair_codes: [] },
    });
    await recordPublished(env, payload, result, workflowStartedAt);
    return result;
  }

  const reasoningStarted = Date.now();
  const configuredReasoningTimeoutMs = Number(env.QL_REASONING_TIMEOUT_MS);
  const reasoningTimeoutMs = Number.isFinite(configuredReasoningTimeoutMs) && configuredReasoningTimeoutMs > 0
    ? configuredReasoningTimeoutMs
    : DEFAULT_REASONING_TIMEOUT_MS;
  await record(env, {
    eventName: "decision_reasoning_started",
    sessionId: payload.session_id,
    requestId: request.request_id,
    stage: "F3",
    modelVersion: reasoningModel,
    promptVersion: REASONER_PROMPT_VERSION,
    properties: { candidate_count: retrieval.candidates.length },
  });

  let verification = null;
  let reasoned = null;
  let reasoningModelCalls = 0;
  const modelUsages = [];
  const verificationRepairCodes = [];
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      reasoningModelCalls += 1;
      try {
        reasoned = await reasonAboutCandidates({
          modelClient: modelClient(env),
          model: reasoningModel,
          request,
          retrieval,
          verificationIssues: verification?.issues ?? [],
          timeoutMs: Math.max(1, reasoningTimeoutMs - (Date.now() - reasoningStarted)),
        });
      } catch (error) {
        if (attempt === 0 && TRANSIENT_REASONING_ERRORS.has(error.code)) {
          verificationRepairCodes.push(error.code);
          continue;
        }
        throw error;
      }
      modelUsages.push(reasoned.usage);
      verificationRepairCodes.push(...reasoned.normalization_codes);
      verification = verifyAndRenderDecisionDraft({
        draft: reasoned.draft,
        request,
        retrieval,
        store,
        modelVersion: reasoned.model_version,
        promptVersion: reasoned.prompt_version,
      });
      if (verification.valid) break;
      verificationRepairCodes.push(...verification.issues.map((issue) => issue.code));
    }
  } catch (error) {
    error.model_calls = (error.model_calls ?? 0) + reasoningModelCalls;
    error.verification_repair_codes = [...new Set(verificationRepairCodes)];
    const failedUsage = [...modelUsages].filter(Boolean);
    if (error.details?.usage) failedUsage.push(error.details.usage);
    await recordModelUsage(env, {
      sessionId: payload.session_id,
      requestId: request.request_id,
      stage: "F3",
      operation: "decision_reasoning",
      modelVersion: reasoningModel,
      promptVersion: REASONER_PROMPT_VERSION,
      modelCalls: reasoningModelCalls,
      usage: failedUsage,
    });
    await record(env, {
      eventName: "decision_reasoning_failed",
      sessionId: payload.session_id,
      requestId: request.request_id,
      stage: "F3",
      modelVersion: reasoningModel,
      promptVersion: REASONER_PROMPT_VERSION,
      errorCode: error.code ?? "DECISION_REASONING_FAILED",
      properties: { duration_ms: elapsedMs(reasoningStarted) },
    });
    throw error;
  }

  if (!verification.valid) {
    await recordModelUsage(env, {
      sessionId: payload.session_id,
      requestId: request.request_id,
      stage: "F3",
      operation: "decision_reasoning",
      modelVersion: reasoningModel,
      promptVersion: REASONER_PROMPT_VERSION,
      modelCalls: reasoningModelCalls,
      usage: modelUsages.filter(Boolean),
    });
    await record(env, {
      eventName: "evidence_verification_blocked",
      sessionId: payload.session_id,
      requestId: request.request_id,
      stage: "F3",
      modelVersion: reasoningModel,
      promptVersion: REASONER_PROMPT_VERSION,
      errorCode: "EVIDENCE_VERIFICATION_BLOCKED",
      properties: {
        claim_count: reasoned?.draft?.candidates?.length ?? 0,
        citation_count: 0,
        blocking_error_code: verification.issues[0]?.code ?? "UNKNOWN",
      },
    });
    const error = new Error("EVIDENCE_VERIFICATION_BLOCKED");
    error.code = "EVIDENCE_VERIFICATION_BLOCKED";
    error.details = verification.issues;
    error.model_calls = reasoningModelCalls;
    error.verification_repair_codes = [...new Set(verificationRepairCodes)];
    throw error;
  }

  const brief = verification.brief;
  await record(env, {
    eventName: "decision_reasoning_succeeded",
    sessionId: payload.session_id,
    requestId: request.request_id,
    stage: "F4",
    modelVersion: reasoningModel,
    promptVersion: REASONER_PROMPT_VERSION,
    properties: { candidate_count: brief.candidates.length, duration_ms: elapsedMs(reasoningStarted) },
  });
  const result = publishedResult({
    brief,
    store,
    retrieval,
    verification,
    metrics: {
      model_calls: reasoningModelCalls,
      usage: modelUsages,
      verification_repair_codes: [...new Set(verificationRepairCodes)],
    },
  });
  await recordPublished(env, payload, result, workflowStartedAt);
  return result;
}

export async function correctAndRecommend(env, payload) {
  const workflowStartedAt = Date.now();
  const interpreted = await interpretDecisionRequest(env, {
    ...payload,
    mode: "correction",
  });
  if (interpreted.clarification.required) return { ...interpreted, brief: null, context: null };
  const recommended = await recommendForDecisionRequest(env, {
    session_id: payload.session_id,
    request: interpreted.request,
  }, { workflowStartedAt });
  return {
    ...interpreted,
    ...recommended,
    metrics: {
      model_calls: (interpreted.metrics?.model_calls ?? 0) + (recommended.metrics?.model_calls ?? 0),
      usage: [...(interpreted.metrics?.usage ?? []), ...(recommended.metrics?.usage ?? [])].filter(Boolean),
      repair_codes: interpreted.metrics?.repair_codes ?? [],
      repair_issues: interpreted.metrics?.repair_issues ?? [],
      verification_repair_codes: recommended.metrics?.verification_repair_codes ?? [],
    },
  };
}

export function publicServiceError(error) {
  if (error instanceof ModelCallError) return { code: error.code, status: error.code === "MODEL_NOT_CONFIGURED" ? 503 : 502 };
  const code = error.code ?? error.message ?? "INTERNAL_ERROR";
  if (["INPUT_EMPTY", "INPUT_TOO_LONG", "INPUT_TYPE_INVALID"].includes(code)) return { code, status: 400 };
  if (code === "UNTRUSTED_INSTRUCTION_BLOCKED") return { code, status: 422 };
  if (code === "EVIDENCE_VERIFICATION_BLOCKED") return { code, status: 422 };
  if (code === "EVIDENCE_UNAVAILABLE") return { code, status: 503 };
  if (String(code).includes("validation") || String(code).includes("SCHEMA")) return { code: "REQUEST_SCHEMA_INVALID", status: 400 };
  return { code: "INTERNAL_ERROR", status: 500 };
}
