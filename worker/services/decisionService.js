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
import { createDeepSeekResponsesClient, ModelCallError } from "../ai/deepseekResponsesClient.js";
import { interpretIntent } from "../ai/intentInterpreter.js";
import { reasonAboutCandidates } from "../ai/decisionReasoner.js";
import { INTENT_PROMPT_VERSION, REASONER_PROMPT_VERSION } from "../ai/prompts.js";
import { analyticsEvent, emitAnalyticsEvent } from "../analytics/telemetry.js";

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
  await emitAnalyticsEvent(env, analyticsEvent(input));
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
    return { brief, context: buildPublicDecisionContext(brief, store, retrieval), verification: { valid: true, issues: [] } };
  }

  if (eligibleCandidateCount === 1) {
    const verification = renderDeterministicSingleCandidate({ request, retrieval, store });
    const brief = verification.brief;
    const citationCount = brief.candidates[0].fit_reasons.reduce(
      (count, reason) => count + reason.evidence_ids.length,
      0,
    );
    await record(env, {
      eventName: "evidence_verification_succeeded",
      sessionId: payload.session_id,
      requestId: request.request_id,
      stage: "F4",
      modelVersion: "not-invoked",
      promptVersion: "deterministic-single-candidate-v0.1.0",
      properties: { claim_count: 1, citation_count: citationCount },
    });
    await record(env, {
      eventName: "decision_published",
      sessionId: payload.session_id,
      requestId: request.request_id,
      stage: "F4",
      modelVersion: "not-invoked",
      promptVersion: "deterministic-single-candidate-v0.1.0",
      properties: {
        candidate_count: 1,
        unknown_count: new Set(brief.candidates[0].unknowns).size,
        total_duration_ms: elapsedMs(workflowStartedAt),
      },
    });
    return {
      brief,
      context: buildPublicDecisionContext(brief, store, retrieval),
      verification,
      metrics: { model_calls: 0, usage: [], verification_repair_codes: [] },
    };
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
  const citationCount = brief.candidates.reduce((count, candidate) => (
    count + candidate.fit_reasons.reduce((sum, reason) => sum + reason.evidence_ids.length, 0)
      + candidate.tradeoffs.reduce((sum, reason) => sum + reason.evidence_ids.length, 0)
  ), 0);
  await record(env, {
    eventName: "decision_reasoning_succeeded",
    sessionId: payload.session_id,
    requestId: request.request_id,
    stage: "F4",
    modelVersion: reasoningModel,
    promptVersion: REASONER_PROMPT_VERSION,
    properties: { candidate_count: brief.candidates.length, duration_ms: elapsedMs(reasoningStarted) },
  });
  await record(env, {
    eventName: "evidence_verification_succeeded",
    sessionId: payload.session_id,
    requestId: request.request_id,
    stage: "F4",
    modelVersion: reasoningModel,
    promptVersion: REASONER_PROMPT_VERSION,
    properties: { claim_count: brief.candidates.length, citation_count: citationCount },
  });
  const context = buildPublicDecisionContext(brief, store, retrieval);
  const unknownCount = new Set(brief.candidates.flatMap((candidate) => candidate.unknowns)).size;
  await record(env, {
    eventName: "decision_published",
    sessionId: payload.session_id,
    requestId: request.request_id,
    stage: "F4",
    modelVersion: reasoningModel,
    promptVersion: REASONER_PROMPT_VERSION,
    properties: {
      candidate_count: brief.candidates.length,
      unknown_count: unknownCount,
      total_duration_ms: elapsedMs(workflowStartedAt),
    },
  });
  return {
    brief,
    context,
    verification,
    metrics: {
      model_calls: reasoningModelCalls,
      usage: modelUsages,
      verification_repair_codes: [...new Set(verificationRepairCodes)],
    },
  };
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
  if (String(code).includes("validation") || String(code).includes("SCHEMA")) return { code: "REQUEST_SCHEMA_INVALID", status: 400 };
  return { code: "INTERNAL_ERROR", status: 500 };
}
