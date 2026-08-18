import {
  correctAndRecommend,
  interpretDecisionRequest,
  publicServiceError,
  recommendForDecisionRequest,
} from "../services/decisionService.js";
import { jsonResponse, readJson, sameOriginAllowed } from "./http.js";
import { emitOperationalEvent } from "../observability/runtime.js";

const ROUTES = {
  "/api/decision/interpret": interpretDecisionRequest,
  "/api/decision/recommend": recommendForDecisionRequest,
  "/api/decision/correct": correctAndRecommend,
};

export async function routeDecisionRequest(request, env) {
  const handler = ROUTES[new URL(request.url).pathname];
  if (!handler) return null;
  if (request.method !== "POST") return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
  if (!sameOriginAllowed(request)) return jsonResponse({ error: { code: "ORIGIN_NOT_ALLOWED" } }, 403);

  try {
    const payload = await readJson(request);
    if (!/^sess-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.session_id ?? "")) {
      return jsonResponse({ error: { code: "SESSION_ID_INVALID" } }, 400);
    }
    if (!/^req-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(payload.request_id ?? payload.request?.request_id ?? "")) {
      return jsonResponse({ error: { code: "REQUEST_ID_INVALID" } }, 400);
    }
    return jsonResponse({ data: await handler(env, payload) });
  } catch (error) {
    const mapped = error.status
      ? { code: error.message, status: error.status }
      : publicServiceError(error);
    await emitOperationalEvent(env, {
      severity: mapped.status >= 500 ? "error" : "warn",
      code: mapped.code,
      requestId: null,
      route: new URL(request.url).pathname,
      status: mapped.status,
    });
    return jsonResponse({ error: { code: mapped.code } }, mapped.status);
  }
}
