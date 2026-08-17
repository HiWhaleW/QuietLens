import { validateAnalyticsEvent } from "../../src/ai-native/analytics/eventContract.js";
import { emitAnalyticsEvent } from "../analytics/telemetry.js";
import { jsonResponse, readJson, sameOriginAllowed } from "./http.js";

export async function routeAnalyticsRequest(request, env) {
  if (new URL(request.url).pathname !== "/api/analytics") return null;
  if (request.method !== "POST") return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
  if (!sameOriginAllowed(request)) return jsonResponse({ error: { code: "ORIGIN_NOT_ALLOWED" } }, 403);
  try {
    const payload = await readJson(request);
    const event = { ...payload, server_at: new Date().toISOString() };
    const result = validateAnalyticsEvent(event);
    if (!result.valid) return jsonResponse({ error: { code: "ANALYTICS_EVENT_INVALID" } }, 400);
    await emitAnalyticsEvent(env, event);
    return jsonResponse({ accepted: true }, 202);
  } catch (error) {
    return jsonResponse({ error: { code: error.message ?? "ANALYTICS_FAILED" } }, error.status ?? 500);
  }
}

