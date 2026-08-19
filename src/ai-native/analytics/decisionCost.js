export const DECISION_COST_SCHEMA_VERSION = "1.0.0";

const OPERATIONS = new Set(["intent_initial", "intent_correction", "decision_reasoning"]);
const OUTCOMES = new Set(["published", "refused", "blocked", "failed"]);
const REQUEST_ID_PATTERN = /^req-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MICROS_PER_UNIT = 1_000_000n;
const TERMINAL_EVENT_OUTCOMES = Object.freeze({
  decision_published: "published",
  decision_refused: "refused",
  evidence_verification_blocked: "blocked",
  decision_reasoning_failed: "failed",
  intent_parse_failed: "failed",
});

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function usageInteger(usage, primary, fallback = null) {
  const value = usage?.[primary] ?? (fallback ? usage?.[fallback] : undefined);
  return nonNegativeInteger(value) ? value : null;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const inputTokens = usageInteger(usage, "input_tokens", "prompt_tokens");
  const outputTokens = usageInteger(usage, "output_tokens", "completion_tokens");
  if (inputTokens === null || outputTokens === null) return null;

  const totalTokens = usageInteger(usage, "total_tokens") ?? inputTokens + outputTokens;
  const cachedInputTokens = usageInteger(
    usage.input_tokens_details ?? usage.prompt_tokens_details,
    "cached_tokens",
  ) ?? 0;
  const reasoningOutputTokens = usageInteger(
    usage.output_tokens_details ?? usage.completion_tokens_details,
    "reasoning_tokens",
  ) ?? 0;
  if (totalTokens !== inputTokens + outputTokens) return null;
  if (cachedInputTokens > inputTokens || reasoningOutputTokens > outputTokens) return null;
  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    total_tokens: totalTokens,
  };
}

function assertObservationIdentity({ operation, modelVersion, promptVersion, modelCalls, usage }) {
  if (!OPERATIONS.has(operation)) throw new Error("DECISION_COST_OPERATION_INVALID");
  if (typeof modelVersion !== "string" || !VERSION_PATTERN.test(modelVersion)) {
    throw new Error("DECISION_COST_MODEL_VERSION_INVALID");
  }
  if (typeof promptVersion !== "string" || !VERSION_PATTERN.test(promptVersion)) {
    throw new Error("DECISION_COST_PROMPT_VERSION_INVALID");
  }
  if (!nonNegativeInteger(modelCalls)) throw new Error("DECISION_COST_MODEL_CALLS_INVALID");
  if (!Array.isArray(usage)) throw new Error("DECISION_COST_USAGE_INVALID");
}

export function createModelUsageObservation({
  operation,
  modelVersion,
  promptVersion,
  modelCalls,
  usage = [],
}) {
  assertObservationIdentity({ operation, modelVersion, promptVersion, modelCalls, usage });
  const normalizedUsage = usage.map(normalizeUsage);
  const validUsage = normalizedUsage.filter(Boolean);
  const totals = validUsage.reduce((sum, entry) => ({
    input_tokens: sum.input_tokens + entry.input_tokens,
    cached_input_tokens: sum.cached_input_tokens + entry.cached_input_tokens,
    output_tokens: sum.output_tokens + entry.output_tokens,
    reasoning_output_tokens: sum.reasoning_output_tokens + entry.reasoning_output_tokens,
    total_tokens: sum.total_tokens + entry.total_tokens,
  }), {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  });
  return Object.freeze({
    cost_schema_version: DECISION_COST_SCHEMA_VERSION,
    operation,
    model_version: modelVersion,
    prompt_version: promptVersion,
    model_call_count: modelCalls,
    reported_usage_call_count: validUsage.length,
    invalid_usage_call_count: normalizedUsage.length - validUsage.length,
    retry_count: Math.max(0, modelCalls - (modelCalls > 0 ? 1 : 0)),
    ...totals,
    usage_complete: validUsage.length === modelCalls && normalizedUsage.length === validUsage.length,
  });
}

export function validateModelUsageObservation(observation) {
  const issues = [];
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    return { valid: false, issues: ["DECISION_COST_OBSERVATION_INVALID"] };
  }
  const expectedKeys = new Set([
    "cost_schema_version",
    "operation",
    "model_version",
    "prompt_version",
    "model_call_count",
    "reported_usage_call_count",
    "invalid_usage_call_count",
    "retry_count",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
    "usage_complete",
  ]);
  for (const key of Object.keys(observation)) {
    if (!expectedKeys.has(key)) issues.push(`DECISION_COST_PROPERTY_UNKNOWN:${key}`);
  }
  if (observation.cost_schema_version !== DECISION_COST_SCHEMA_VERSION) {
    issues.push("DECISION_COST_SCHEMA_VERSION_INVALID");
  }
  if (!OPERATIONS.has(observation.operation)) issues.push("DECISION_COST_OPERATION_INVALID");
  if (typeof observation.model_version !== "string" || !VERSION_PATTERN.test(observation.model_version)) {
    issues.push("DECISION_COST_MODEL_VERSION_INVALID");
  }
  if (typeof observation.prompt_version !== "string" || !VERSION_PATTERN.test(observation.prompt_version)) {
    issues.push("DECISION_COST_PROMPT_VERSION_INVALID");
  }
  for (const key of [
    "model_call_count",
    "reported_usage_call_count",
    "invalid_usage_call_count",
    "retry_count",
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ]) {
    if (!nonNegativeInteger(observation[key])) issues.push(`DECISION_COST_INTEGER_INVALID:${key}`);
  }
  if (typeof observation.usage_complete !== "boolean") issues.push("DECISION_COST_USAGE_COMPLETE_INVALID");
  if (nonNegativeInteger(observation.cached_input_tokens)
    && nonNegativeInteger(observation.input_tokens)
    && observation.cached_input_tokens > observation.input_tokens) {
    issues.push("DECISION_COST_CACHED_TOKENS_INVALID");
  }
  if (nonNegativeInteger(observation.reasoning_output_tokens)
    && nonNegativeInteger(observation.output_tokens)
    && observation.reasoning_output_tokens > observation.output_tokens) {
    issues.push("DECISION_COST_REASONING_TOKENS_INVALID");
  }
  if (nonNegativeInteger(observation.total_tokens)
    && nonNegativeInteger(observation.input_tokens)
    && nonNegativeInteger(observation.output_tokens)
    && observation.total_tokens !== observation.input_tokens + observation.output_tokens) {
    issues.push("DECISION_COST_TOTAL_TOKENS_INVALID");
  }
  if (nonNegativeInteger(observation.model_call_count)
    && nonNegativeInteger(observation.reported_usage_call_count)
    && observation.reported_usage_call_count > observation.model_call_count) {
    issues.push("DECISION_COST_USAGE_CALL_COUNT_INVALID");
  }
  if (nonNegativeInteger(observation.model_call_count)
    && nonNegativeInteger(observation.reported_usage_call_count)
    && nonNegativeInteger(observation.invalid_usage_call_count)
    && observation.reported_usage_call_count + observation.invalid_usage_call_count > observation.model_call_count) {
    issues.push("DECISION_COST_USAGE_ENTRY_COUNT_INVALID");
  }
  if (nonNegativeInteger(observation.model_call_count)
    && nonNegativeInteger(observation.retry_count)
    && observation.retry_count !== Math.max(0, observation.model_call_count - (observation.model_call_count > 0 ? 1 : 0))) {
    issues.push("DECISION_COST_RETRY_COUNT_INVALID");
  }
  if (observation.usage_complete === true
    && (observation.reported_usage_call_count !== observation.model_call_count
      || observation.invalid_usage_call_count !== 0)) {
    issues.push("DECISION_COST_USAGE_COVERAGE_INVALID");
  }
  return { valid: issues.length === 0, issues };
}

function assertPriceCatalog(priceCatalog) {
  if (!priceCatalog || typeof priceCatalog !== "object" || Array.isArray(priceCatalog)) {
    throw new Error("DECISION_COST_PRICE_CATALOG_INVALID");
  }
  if (typeof priceCatalog.catalog_version !== "string"
    || !VERSION_PATTERN.test(priceCatalog.catalog_version)) {
    throw new Error("DECISION_COST_PRICE_VERSION_INVALID");
  }
  if (typeof priceCatalog.currency !== "string" || !CURRENCY_PATTERN.test(priceCatalog.currency)) {
    throw new Error("DECISION_COST_CURRENCY_INVALID");
  }
  if (!priceCatalog.models || typeof priceCatalog.models !== "object" || Array.isArray(priceCatalog.models)) {
    throw new Error("DECISION_COST_MODEL_PRICES_INVALID");
  }
}

function priceStatus(observations, priceCatalog) {
  if (observations.some((observation) => observation.usage_complete !== true)) return "usage_incomplete";
  if (observations.every((observation) => observation.model_call_count === 0)) return "calculated";
  if (!priceCatalog) return "price_catalog_missing";
  for (const observation of observations) {
    if (observation.model_call_count === 0) continue;
    const price = priceCatalog.models[observation.model_version];
    if (!price) return "model_price_missing";
    if (!nonNegativeInteger(price.input_microunits_per_million)
      || !nonNegativeInteger(price.output_microunits_per_million)) {
      return "model_price_invalid";
    }
    if (observation.cached_input_tokens > 0
      && !nonNegativeInteger(price.cached_input_microunits_per_million)) {
      return "cached_input_price_missing";
    }
  }
  return "calculated";
}

function observationCostNumerator(observation, price) {
  const uncachedInputTokens = BigInt(observation.input_tokens - observation.cached_input_tokens);
  return (uncachedInputTokens * BigInt(price.input_microunits_per_million))
    + (BigInt(observation.cached_input_tokens) * BigInt(price.cached_input_microunits_per_million ?? 0))
    + (BigInt(observation.output_tokens) * BigInt(price.output_microunits_per_million));
}

export function aggregateDecisionCost({
  requestId,
  outcome,
  observations,
  priceCatalog = null,
}) {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("DECISION_COST_REQUEST_ID_INVALID");
  }
  if (!OUTCOMES.has(outcome)) throw new Error("DECISION_COST_OUTCOME_INVALID");
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error("DECISION_COST_OBSERVATIONS_REQUIRED");
  }
  for (const observation of observations) {
    const validation = validateModelUsageObservation(observation);
    if (!validation.valid) throw new Error(validation.issues.join(";"));
  }
  if (priceCatalog) assertPriceCatalog(priceCatalog);

  const totals = observations.reduce((sum, observation) => ({
    model_call_count: sum.model_call_count + observation.model_call_count,
    reported_usage_call_count: sum.reported_usage_call_count + observation.reported_usage_call_count,
    invalid_usage_call_count: sum.invalid_usage_call_count + observation.invalid_usage_call_count,
    retry_count: sum.retry_count + observation.retry_count,
    input_tokens: sum.input_tokens + observation.input_tokens,
    cached_input_tokens: sum.cached_input_tokens + observation.cached_input_tokens,
    output_tokens: sum.output_tokens + observation.output_tokens,
    reasoning_output_tokens: sum.reasoning_output_tokens + observation.reasoning_output_tokens,
    total_tokens: sum.total_tokens + observation.total_tokens,
  }), {
    model_call_count: 0,
    reported_usage_call_count: 0,
    invalid_usage_call_count: 0,
    retry_count: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0,
  });
  const status = priceStatus(observations, priceCatalog);
  const costNumerator = status === "calculated" && priceCatalog
    ? observations.reduce((sum, observation) => (
      observation.model_call_count === 0
        ? sum
        : sum + observationCostNumerator(observation, priceCatalog.models[observation.model_version])
    ), 0n)
    : 0n;
  const roundedCostMicrounits = (costNumerator + MICROS_PER_UNIT - 1n) / MICROS_PER_UNIT;
  if (roundedCostMicrounits > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("DECISION_COST_TOTAL_OVERFLOW");
  }
  const estimatedCostMicrounits = status === "calculated"
    ? Number(roundedCostMicrounits)
    : null;
  return Object.freeze({
    cost_schema_version: DECISION_COST_SCHEMA_VERSION,
    request_id: requestId,
    outcome,
    operation_count: observations.length,
    ...totals,
    usage_coverage_complete: observations.every((observation) => observation.usage_complete),
    cost_status: status,
    currency: status === "calculated" && priceCatalog ? priceCatalog.currency : null,
    price_catalog_version: status === "calculated" && priceCatalog ? priceCatalog.catalog_version : null,
    estimated_cost_microunits: estimatedCostMicrounits,
    rounding_policy: "ceil_to_microunit",
  });
}

export function aggregateDecisionCostEvents({
  requestId,
  events,
  priceCatalog = null,
}) {
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new Error("DECISION_COST_REQUEST_ID_INVALID");
  }
  if (!Array.isArray(events)) throw new Error("DECISION_COST_EVENTS_INVALID");
  const requestEvents = events.filter((event) => event?.request_id === requestId);
  const observations = requestEvents
    .filter((event) => event.event_name === "model_usage_observed")
    .map((event) => event.properties);
  let outcome = null;
  for (const event of requestEvents) {
    if (TERMINAL_EVENT_OUTCOMES[event.event_name]) outcome = TERMINAL_EVENT_OUTCOMES[event.event_name];
  }
  if (!outcome) throw new Error("DECISION_COST_TERMINAL_EVENT_REQUIRED");
  return aggregateDecisionCost({ requestId, outcome, observations, priceCatalog });
}
