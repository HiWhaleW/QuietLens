import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker/index.js";
import { checkRateLimit, resetRateLimit } from "../worker/security/rateLimit.js";

// Every deployed entry point rebuilds `env` per request: the generated
// dist/server/index.js spreads `{ ...env, QUIETLENS_EVIDENCE_STORE }` and
// scripts/serve-vefaas.mjs spreads `{ ...process.env, ASSETS }`. These tests
// mirror that shape rather than reusing one object, because a reused object
// hides whether the counter actually persists.
function freshEnv(overrides = {}) {
  return {
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    QUIETLENS_ANALYTICS_SINK: { write: async () => {} },
    QL_RATE_LIMIT_MAX: "3",
    QL_RATE_LIMIT_WINDOW_MS: "60000",
    ...overrides,
  };
}

function analyticsRequest(clientIp) {
  return new Request("https://quietlens.test/api/analytics", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://quietlens.test",
      "x-forwarded-for": clientIp,
    },
    body: "{}",
  });
}

test("counts API writes across requests that each carry a fresh env object", async () => {
  resetRateLimit();
  const statuses = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await worker.fetch(analyticsRequest("203.0.113.10"), freshEnv());
    statuses.push(response.status);
  }
  assert.equal(statuses.filter((status) => status === 429).length, 2, `expected the 4th and 5th write to be limited, got ${statuses.join(",")}`);
  assert.deepEqual(statuses.slice(3), [429, 429]);
});

test("keeps a separate budget per client address", async () => {
  resetRateLimit();
  const first = await worker.fetch(analyticsRequest("203.0.113.20"), freshEnv({ QL_RATE_LIMIT_MAX: "1" }));
  const second = await worker.fetch(analyticsRequest("203.0.113.20"), freshEnv({ QL_RATE_LIMIT_MAX: "1" }));
  const other = await worker.fetch(analyticsRequest("203.0.113.21"), freshEnv({ QL_RATE_LIMIT_MAX: "1" }));

  assert.notEqual(first.status, 429);
  assert.equal(second.status, 429);
  assert.notEqual(other.status, 429, "a second client must not inherit the first client's budget");
});

test("returns a deterministic retry contract when limited", async () => {
  resetRateLimit();
  await worker.fetch(analyticsRequest("203.0.113.30"), freshEnv({ QL_RATE_LIMIT_MAX: "1" }));
  const limited = await worker.fetch(analyticsRequest("203.0.113.30"), freshEnv({ QL_RATE_LIMIT_MAX: "1" }));

  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(limited.headers.get("x-ratelimit-limit"), "1");
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
  assert.equal(limited.headers.get("x-content-type-options"), "nosniff");
});

test("accumulates in checkRateLimit even when the env object identity changes", () => {
  resetRateLimit();
  const request = () => new Request("https://quietlens.test/api/decision/recommend", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.40" },
  });

  const outcomes = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    outcomes.push(checkRateLimit(request(), freshEnv({ QL_RATE_LIMIT_MAX: "2" })).allowed);
  }

  assert.deepEqual(outcomes, [true, true, false, false]);
});
