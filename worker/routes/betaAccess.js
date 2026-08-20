import {
  authenticateBetaRequest,
  betaSessionCookie,
  clearBetaSessionCookie,
  createBetaSession,
  isBetaAccessEnabled,
  parseBetaAccessConfig,
  redeemBetaInvite,
} from "../beta/inviteAccess.js";
import { jsonResponse, readJson, sameOriginAllowed } from "./http.js";

const PREFIX = "/api/beta-access/";

export function isBetaAccessPath(pathname) {
  return pathname.startsWith(PREFIX);
}

function responseWithCookie(value, cookie, status = 200) {
  const response = jsonResponse(value, status);
  response.headers.set("set-cookie", cookie);
  return response;
}

function configOrResponse(env) {
  try {
    return { config: parseBetaAccessConfig(env) };
  } catch {
    return { response: jsonResponse({ error: { code: "BETA_ACCESS_NOT_CONFIGURED" } }, 503) };
  }
}

export async function routeBetaAccessRequest(request, env) {
  const pathname = new URL(request.url).pathname;
  if (!isBetaAccessPath(pathname)) return null;

  if (pathname === `${PREFIX}session` && request.method === "GET") {
    if (!isBetaAccessEnabled(env)) return jsonResponse({ data: { enabled: false, authenticated: true } });
    const resolved = configOrResponse(env);
    if (resolved.response) return resolved.response;
    try {
      const session = await authenticateBetaRequest(request, resolved.config);
      return jsonResponse({ data: { enabled: true, authenticated: true, expires_at: session.expires_at } });
    } catch {
      return jsonResponse({ data: { enabled: true, authenticated: false } });
    }
  }

  if (pathname === `${PREFIX}redeem` && request.method === "POST") {
    if (!sameOriginAllowed(request)) return jsonResponse({ error: { code: "ORIGIN_NOT_ALLOWED" } }, 403);
    if (!isBetaAccessEnabled(env)) return jsonResponse({ error: { code: "API_NOT_FOUND" } }, 404);
    const resolved = configOrResponse(env);
    if (resolved.response) return resolved.response;
    try {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).length !== 1 || typeof body.code !== "string") {
        return jsonResponse({ error: { code: "BETA_INVITE_INVALID" } }, 401);
      }
      const invitation = await redeemBetaInvite(body.code.trim(), resolved.config);
      const session = await createBetaSession(invitation, resolved.config);
      return responseWithCookie(
        { data: { authenticated: true, expires_at: session.payload.expires_at } },
        betaSessionCookie(session.token, resolved.config.ttlSeconds),
      );
    } catch (error) {
      if (error?.status) return jsonResponse({ error: { code: error.message } }, error.status);
      return jsonResponse({ error: { code: "BETA_INVITE_INVALID" } }, 401);
    }
  }

  if (pathname === `${PREFIX}session` && request.method === "DELETE") {
    if (!sameOriginAllowed(request)) return jsonResponse({ error: { code: "ORIGIN_NOT_ALLOWED" } }, 403);
    return responseWithCookie({ data: { authenticated: false } }, clearBetaSessionCookie());
  }

  return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
}

export async function authorizeBetaApiRequest(request, env) {
  if (!isBetaAccessEnabled(env)) return Object.freeze({ allowed: true, request });
  let config;
  try {
    config = parseBetaAccessConfig(env);
  } catch {
    return Object.freeze({ allowed: false, response: jsonResponse({ error: { code: "BETA_ACCESS_NOT_CONFIGURED" } }, 503) });
  }
  try {
    const session = await authenticateBetaRequest(request, config);
    const headers = new Headers(request.headers);
    headers.delete("x-quietlens-beta-participant-id");
    headers.set("x-quietlens-beta-participant-id", session.participant_id);
    return Object.freeze({ allowed: true, request: new Request(request, { headers }), session });
  } catch {
    return Object.freeze({ allowed: false, response: jsonResponse({ error: { code: "BETA_SESSION_REQUIRED" } }, 401) });
  }
}
