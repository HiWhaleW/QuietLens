const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

// Buckets are held at module scope so they survive across requests inside one
// runtime instance, which is what QL_RATE_LIMIT_MAX documents.
//
// They used to live in a WeakMap keyed by `env`. Every entry point builds a
// fresh `env` object per request -- the generated dist/server/index.js spreads
// `{ ...env, QUIETLENS_EVIDENCE_STORE }` and scripts/serve-vefaas.mjs spreads
// `{ ...process.env, ASSETS }` -- so the lookup missed every time and each
// request counted against an empty bucket. The limit never engaged in any
// deployed configuration.
const buckets = new Map();
let nextSweepAt = 0;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function bucketKey(request) {
  const forwarded = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || `local:${new URL(request.url).host}`;
}

// Expired buckets are dropped so a long-lived instance does not accumulate one
// entry per client address. If live keys still exceed the cap, the entries
// closest to expiry are released first.
function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
  if (buckets.size <= MAX_TRACKED_KEYS) return;
  const overflow = [...buckets.entries()]
    .sort((left, right) => left[1].resetAt - right[1].resetAt)
    .slice(0, buckets.size - MAX_TRACKED_KEYS);
  for (const [key] of overflow) buckets.delete(key);
}

// Test-only. Module-scoped buckets outlive a single test, so suites that assert
// on limit behaviour must start from a known state instead of inheriting counts
// from requests made earlier in the same process.
export function resetRateLimit() {
  buckets.clear();
  nextSweepAt = 0;
}

export function checkRateLimit(request, env) {
  const limit = positiveInteger(env.QL_RATE_LIMIT_MAX, DEFAULT_LIMIT);
  const windowMs = positiveInteger(env.QL_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);

  const key = bucketKey(request);
  const now = Date.now();
  if (now >= nextSweepAt || buckets.size > MAX_TRACKED_KEYS) {
    sweep(now);
    nextSweepAt = now + windowMs;
  }

  const current = buckets.get(key);
  const bucket = !current || now >= current.resetAt
    ? { count: 0, resetAt: now + windowMs }
    : current;
  bucket.count += 1;
  buckets.set(key, bucket);

  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}
