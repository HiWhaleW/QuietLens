import { routeAnalyticsRequest } from "./routes/analytics.js";
import {
  authorizeBetaApiRequest,
  isBetaAccessPath,
  routeBetaAccessRequest,
} from "./routes/betaAccess.js";
import { routeDecisionRequest } from "./routes/decision.js";
import { routeEvidenceReviewRequest } from "./routes/evidenceReview.js";
import { routeHealthRequest } from "./routes/health.js";
import { jsonResponse, withSecurityHeaders } from "./routes/http.js";
import { checkRateLimit } from "./security/rateLimit.js";

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    const healthResponse = routeHealthRequest(request, env);
    if (healthResponse) return withSecurityHeaders(healthResponse);

    const isEvidenceReviewPath = pathname.startsWith("/api/evidence-review/");
    if ((!isEvidenceReviewPath && request.method === "POST" && pathname.startsWith("/api/"))
      || (isEvidenceReviewPath && env?.QL_EVIDENCE_REVIEW_API_ENABLED === "true")) {
      const rate = checkRateLimit(request, env);
      if (!rate.allowed) {
        const response = jsonResponse({ error: { code: "RATE_LIMITED" } }, 429);
        response.headers.set("retry-after", String(rate.retryAfterSeconds));
        response.headers.set("x-ratelimit-limit", String(rate.limit));
        response.headers.set("x-ratelimit-remaining", String(rate.remaining));
        return withSecurityHeaders(response);
      }
    }

    const betaResponse = await routeBetaAccessRequest(request, env);
    if (betaResponse) return withSecurityHeaders(betaResponse);

    let authorizedRequest = request;
    if (pathname.startsWith("/api/") && !isBetaAccessPath(pathname)) {
      const authorization = await authorizeBetaApiRequest(request, env);
      if (!authorization.allowed) return withSecurityHeaders(authorization.response);
      authorizedRequest = authorization.request;
    }

    const apiResponse = await routeEvidenceReviewRequest(authorizedRequest, env)
      ?? await routeDecisionRequest(authorizedRequest, env)
      ?? await routeAnalyticsRequest(authorizedRequest, env);
    if (apiResponse) return withSecurityHeaders(apiResponse);
    if (pathname.startsWith("/api/")) {
      return withSecurityHeaders(jsonResponse({ error: { code: "API_NOT_FOUND" } }, 404));
    }

    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");

    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) {
      return withSecurityHeaders(response);
    }

    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return withSecurityHeaders(await env.ASSETS.fetch(new Request(indexUrl, request)));
  },
};
