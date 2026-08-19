const bucketsByEnvironment = new WeakMap();
const DEFAULT_LIMIT = 30;
const DEFAULT_WINDOW_MS = 60_000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function bucketKey(request) {
  const forwarded = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || `local:${new URL(request.url).host}`;
}

export function checkRateLimit(request, env) {
  const limit = positiveInteger(env.QL_RATE_LIMIT_MAX, DEFAULT_LIMIT);
  const windowMs = positiveInteger(env.QL_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS);
  let buckets = bucketsByEnvironment.get(env);
  if (!buckets) {
    buckets = new Map();
    bucketsByEnvironment.set(env, buckets);
  }

  const key = bucketKey(request);
  const now = Date.now();
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
