const crypto = require('crypto');

const AUTH_SECRET = process.env.AUTH_SECRET || '';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(input) {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function sign(body) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Signed, expiring session token — HMAC-SHA256, no external JWT library needed.
function issueToken(email, plan) {
  if (!AUTH_SECRET) throw new Error('AUTH_SECRET not configured');
  const payload = { sub: email, plan, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS };
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !AUTH_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(base64urlDecode(body)); } catch { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function getBearerToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// Server-to-server calls (e.g. railway/server.js calling back into Vercel APIs)
// have no user session to present — they authenticate with a separate shared
// secret instead of a user token.
function isInternalRequest(req) {
  const secret = process.env.INTERNAL_API_SECRET || '';
  if (!secret) return false;
  return req.headers['x-internal-secret'] === secret;
}

// Call at the top of a handler. Returns the token payload ({sub, plan, ...}) on
// success, or writes a 401 response and returns null on failure — check for
// null and `return` immediately when that happens.
function requireAuth(req, res) {
  if (isInternalRequest(req)) return { internal: true };
  const payload = verifyToken(getBearerToken(req));
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return payload;
}

module.exports = { issueToken, verifyToken, requireAuth, getBearerToken, isInternalRequest };
