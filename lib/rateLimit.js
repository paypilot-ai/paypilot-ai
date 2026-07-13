// Pragmatic per-instance, per-IP rate limiter for unauthenticated endpoints.
// Not distributed — resets on cold start and isn't shared across serverless
// instances — but it stops scripted hammering of paid upstream APIs, which
// is the actual threat model for the demo-accessible endpoints that use it.
const buckets = new Map();
const MAX_BUCKETS = 5000;

function getClientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

function rateLimit(req, res, { key = 'default', limit = 20, windowMs = 60_000, identifier } = {}) {
  const id = identifier || getClientIp(req);
  const bucketKey = `${key}:${id}`;
  const now = Date.now();

  if (buckets.size > MAX_BUCKETS) {
    for (const [k, v] of buckets) { if (now - v.start > windowMs) buckets.delete(k); }
  }

  let bucket = buckets.get(bucketKey);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    buckets.set(bucketKey, bucket);
  }
  bucket.count++;

  if (bucket.count > limit) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.start + windowMs - now) / 1000)));
    res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    return false;
  }
  return true;
}

module.exports = { rateLimit };
