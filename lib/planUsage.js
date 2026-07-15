// Best-effort, in-memory dial-count cap for real provisioned customer accounts
// (see api/create-checkout.js's Stripe webhook). Not persistent — resets on
// cold start/redeploy, since this project has no database. Good enough to
// stop unbounded usage on a flat-fee plan; not a substitute for real metered
// billing, which would need persistent storage and Stripe usage records.
const PLAN_DIAL_LIMITS = { starter: 25, pro: 100 };
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days

const usage = new Map(); // email -> { start, count }

function checkAndIncrementDialUsage(email, plan) {
  const limit = PLAN_DIAL_LIMITS[plan];
  if (!limit) return { allowed: true }; // unknown/enterprise plan — no cap enforced here

  const now = Date.now();
  let rec = usage.get(email);
  if (!rec || now - rec.start > WINDOW_MS) {
    rec = { start: now, count: 0 };
    usage.set(email, rec);
  }

  if (rec.count >= limit) {
    return { allowed: false, used: rec.count, limit };
  }
  rec.count++;
  return { allowed: true, used: rec.count, limit };
}

module.exports = { checkAndIncrementDialUsage };
