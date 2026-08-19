import { aggregateDecisionCostEvents } from "./decisionCost.js";
import {
  DEEPSEEK_PRICE_SOURCE,
  deepSeekPriceCatalogForEvents,
} from "./deepseekPriceCatalog.js";
import { deepSeekPriceReviewStatus } from "./decisionCostRetention.js";

export const DECISION_COST_EXPORT_SCHEMA_VERSION = "1.0.0";

const TERMINAL_OUTCOMES = Object.freeze({
  decision_published: "published",
  decision_refused: "refused",
  evidence_verification_blocked: "blocked",
  decision_reasoning_failed: "failed",
  intent_parse_failed: "failed",
});

function validDateTime(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function terminalRequests(events) {
  const requests = new Map();
  for (const event of events) {
    const outcome = TERMINAL_OUTCOMES[event?.event_name];
    if (!outcome || typeof event.request_id !== "string") continue;
    requests.set(event.request_id, outcome);
  }
  return [...requests.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function missingObservationReport(requestId, outcome) {
  return Object.freeze({
    request_id: requestId,
    outcome,
    operation_count: 0,
    model_call_count: null,
    retry_count: null,
    input_tokens: null,
    cached_input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    usage_coverage_complete: false,
    cost_status: "observation_missing",
    currency: null,
    price_catalog_version: null,
    estimated_cost_microunits: null,
    issue_code: "DECISION_COST_OBSERVATIONS_REQUIRED",
  });
}

function reportForRequest(requestId, outcome, requestEvents, priceReview) {
  if (!requestEvents.some((event) => event.event_name === "model_usage_observed")) {
    return missingObservationReport(requestId, outcome);
  }
  try {
    const report = {
      ...aggregateDecisionCostEvents({
        requestId,
        events: requestEvents,
        priceCatalog: deepSeekPriceCatalogForEvents(requestEvents),
      }),
      issue_code: null,
    };
    if (priceReview.blocks_cost_calculation && report.model_call_count > 0) {
      return Object.freeze({
        ...report,
        cost_status: "price_review_overdue",
        currency: null,
        price_catalog_version: null,
        estimated_cost_microunits: null,
        issue_code: "DEEPSEEK_PRICE_REVIEW_OVERDUE",
      });
    }
    return Object.freeze(report);
  } catch (error) {
    if (error.message !== "DEEPSEEK_PRICE_WINDOW_MIXED") throw error;
    const usageOnly = aggregateDecisionCostEvents({ requestId, events: requestEvents });
    return Object.freeze({
      ...usageOnly,
      cost_status: "price_window_mixed",
      currency: null,
      price_catalog_version: null,
      estimated_cost_microunits: null,
      issue_code: error.message,
    });
  }
}

export function buildDecisionCostExport({ events, generatedAt }) {
  if (!Array.isArray(events)) throw new Error("DECISION_COST_EXPORT_EVENTS_INVALID");
  if (!validDateTime(generatedAt)) throw new Error("DECISION_COST_EXPORT_TIME_INVALID");

  const priceReview = deepSeekPriceReviewStatus({
    verifiedAt: DEEPSEEK_PRICE_SOURCE.verified_at,
    asOf: generatedAt.slice(0, 10),
  });
  const reports = terminalRequests(events).map(([requestId, outcome]) => {
    const requestEvents = events.filter((event) => event?.request_id === requestId);
    return reportForRequest(requestId, outcome, requestEvents, priceReview);
  });
  const qualified = reports.filter((report) => report.outcome === "published");
  const qualifiedUsageComplete = qualified.filter((report) => report.usage_coverage_complete).length;
  const qualifiedCostCalculated = qualified.filter((report) => report.cost_status === "calculated").length;
  return Object.freeze({
    export_schema_version: DECISION_COST_EXPORT_SCHEMA_VERSION,
    generated_at: generatedAt,
    price_source: DEEPSEEK_PRICE_SOURCE,
    price_review: priceReview,
    terminal_decision_count: reports.length,
    qualified_decision_count: qualified.length,
    qualified_usage_complete_count: qualifiedUsageComplete,
    qualified_cost_calculated_count: qualifiedCostCalculated,
    qualified_usage_coverage_rate: ratio(qualifiedUsageComplete, qualified.length),
    qualified_cost_coverage_rate: ratio(qualifiedCostCalculated, qualified.length),
    reports,
  });
}
