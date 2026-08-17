import { routeAnalyticsRequest } from "./routes/analytics.js";
import { routeDecisionRequest } from "./routes/decision.js";
import { routeHealthRequest } from "./routes/health.js";
import { jsonResponse, withSecurityHeaders } from "./routes/http.js";
import { checkRateLimit } from "./security/rateLimit.js";

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    const healthResponse = routeHealthRequest(request, env);
    if (healthResponse) return withSecurityHeaders(healthResponse);

    if (request.method === "POST" && pathname.startsWith("/api/")) {
      const rate = checkRateLimit(request, env);
      if (!rate.allowed) {
        const response = jsonResponse({ error: { code: "RATE_LIMITED" } }, 429);
        response.headers.set("retry-after", String(rate.retryAfterSeconds));
        response.headers.set("x-ratelimit-limit", String(rate.limit));
        response.headers.set("x-ratelimit-remaining", String(rate.remaining));
        return withSecurityHeaders(response);
      }
    }

    const apiResponse = await routeDecisionRequest(request, env)
      ?? await routeAnalyticsRequest(request, env);
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
