import {
  SERVER_ONLY_EVENT_NAMES,
  validateAnalyticsEvent,
} from "../../src/ai-native/analytics/eventContract.js";
import { emitAnalyticsEvent } from "../analytics/telemetry.js";
import { emitOperationalEvent } from "../observability/runtime.js";
import {
  isRequestFault,
  jsonResponse,
  readJson,
  sameOriginAllowed,
} from "./http.js";

export async function routeAnalyticsRequest(request, env) {
  if (new URL(request.url).pathname !== "/api/analytics") return null;
  if (request.method !== "POST") return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
  if (!sameOriginAllowed(request)) return jsonResponse({ error: { code: "ORIGIN_NOT_ALLOWED" } }, 403);
  try {
    const payload = await readJson(request);
    // A JSON body of `null`, an array, or a bare scalar is a malformed event,
    // not an internal fault. Reading event_name off it used to throw and the
    // raw TypeError message was returned to the caller with a 500.
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return jsonResponse({ error: { code: "ANALYTICS_EVENT_INVALID" } }, 400);
    }
    if (SERVER_ONLY_EVENT_NAMES.includes(payload.event_name)) {
      return jsonResponse({ error: { code: "ANALYTICS_EVENT_SERVER_ONLY" } }, 403);
    }
    const event = { ...payload, server_at: new Date().toISOString() };
    const result = validateAnalyticsEvent(event);
    if (!result.valid) return jsonResponse({ error: { code: "ANALYTICS_EVENT_INVALID" } }, 400);
    await emitAnalyticsEvent(env, event);
    return jsonResponse({ accepted: true }, 202);
  } catch (error) {
    // Only faults created by the request parser are safe to expose. Downstream
    // errors may carry a status and a secret-bearing message of their own.
    if (isRequestFault(error)) return jsonResponse({ error: { code: error.code } }, error.status);
    await emitOperationalEvent(env, {
      severity: "error",
      code: "ANALYTICS_FAILED",
      route: "/api/analytics",
      status: 500,
    });
    return jsonResponse({ error: { code: "ANALYTICS_FAILED" } }, 500);
  }
}
