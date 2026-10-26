const { verifyStripeSignature, readRawBody } = require('../lib/stripeAuth');
const { issueToken } = require('../lib/sessionAuth');

// Vercel auto-parses JSON bodies by default, but Stripe webhook signature
// verification needs the exact raw bytes — so body parsing is disabled for
// this whole file and both the checkout-creation and webhook paths below
// parse the raw body themselves.
module.exports.config = { api: { bodyParser: false } };

const PRICE_IDS = {
  starter: 'price_1TQdvP84nVx3JlYAn5pAbYAb',
  pro: 'price_1TQdx284nVx3JlYAHl6dGlci'
};
const PLAN_BY_PRICE_ID = Object.fromEntries(Object.entries(PRICE_IDS).map(([plan, id]) => [id, plan]));

async function sendWelcomeEmail(email, plan, token) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.error('[stripe-webhook] RESEND_API_KEY not configured — cannot send welcome email'); return; }
  const fromEmail = process.env.FROM_EMAIL || 'info@paypilotai.live';
  const fromName  = process.env.FROM_NAME  || 'PayPilot AI';
  const loginUrl = `https://paypilotai.live/?token=${encodeURIComponent(token)}&plan=${encodeURIComponent(plan)}`;
  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;">
      <h2 style="color:#0f172a;">Welcome to PayPilot AI!</h2>
      <p style="color:#374151;font-size:16px;line-height:1.7;">
        Your ${plan} plan is active. Click below to log in and get started — this link signs you in automatically.
      </p>
      <p style="margin:28px 0;"><a href="${loginUrl}" style="background:#1a6fff;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;">Log In to PayPilot AI</a></p>
      <p style="color:#64748b;font-size:14px;">Questions? Just reply to this email.</p>
    </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({ from: `${fromName} <${fromEmail}>`, to: [email], subject: 'Welcome to PayPilot AI — you\'re all set', html }),
    });
  } catch (e) {
    console.error('[stripe-webhook] welcome email failed:', e.message);
  }
}

// Tell the owner about every new paid signup.
async function notifyOwner(session, email, plan) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const fromEmail = process.env.FROM_EMAIL || 'info@paypilotai.live';
  const to = (process.env.SIGNUP_NOTIFY_EMAIL || 'info@paypilotai.live').split(',').map(x => x.trim()).filter(Boolean);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const name = session.customer_details?.name || '';
  const phone = session.customer_details?.phone || '';
  const amount = typeof session.amount_total === 'number'
    ? `$${(session.amount_total / 100).toFixed(2)} ${String(session.currency || 'usd').toUpperCase()}` : '';
  const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
  const planName = plan.charAt(0).toUpperCase() + plan.slice(1);
  const rows = [['Name', name], ['Email', email], ['Phone', phone], ['Plan', planName], ['Paid', amount], ['When', when + ' ET']]
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#64748b;">${k}</td><td style="padding:6px 0;color:#0f172a;font-weight:600;">${esc(v)}</td></tr>`).join('');
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from: `PayPilot AI <${fromEmail}>`, to, reply_to: email,
        subject: `New signup: ${name || email} (${planName})`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;"><h2 style="color:#0f172a;margin:0 0 12px;">New PayPilot AI signup</h2><table style="font-size:15px;border-collapse:collapse;">${rows}</table><p style="color:#64748b;font-size:13px;margin-top:20px;">Reply to this email to reach them directly.</p></div>`,
      }),
    });
    if (!r.ok) console.error('[stripe-webhook] owner signup alert failed:', r.status, (await r.text()).slice(0, 200));
  } catch (e) {
    console.error('[stripe-webhook] owner signup alert failed:', e.message);
  }
}

// Look up a Checkout Session fresh from Stripe and alert the owner exactly once
// (marked on the session itself, so a page refresh or a webhook retry won't
// send a second alert). Runs from the success page and from the webhook.
async function notifyOwnerOnce(sessionId) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) return false;
  const auth = { Authorization: 'Bearer ' + key };
  const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, { headers: auth });
  if (!r.ok) return false;
  const session = await r.json();
  const paid = session.status === 'complete' && ['paid', 'no_payment_required'].includes(session.payment_status);
  if (!paid || session.metadata?.owner_notified === '1') return false;
  // Claim it first, so two near-simultaneous runs don't both send.
  await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ 'metadata[owner_notified]': '1' }).toString(),
  });
  const email = session.customer_details?.email || session.customer_email || '(no email given)';
  await notifyOwner(session, email, session.metadata?.plan || 'starter');
  return true;
}

async function handleWebhook(req, res, rawBody) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(rawBody, sig, secret)) {
    console.error('[stripe-webhook] rejected — invalid or missing signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object || {};
    const email = session.customer_details?.email || session.customer_email;
    const plan = session.metadata?.plan || 'starter';
    try { await notifyOwnerOnce(session.id); } catch (e) { console.error('[stripe-webhook] signup alert:', e.message); }
    if (!email) {
      console.error('[stripe-webhook] checkout.session.completed with no customer email — cannot provision account');
      return res.status(200).json({ received: true });
    }
    try {
      const token = issueToken(email, plan);
      await sendWelcomeEmail(email, plan, token);
      console.log('[stripe-webhook] provisioned account for', email, 'plan:', plan);
    } catch (e) {
      // AUTH_SECRET not configured yet, or email send failed — log but still
      // acknowledge the webhook so Stripe doesn't retry indefinitely.
      console.error('[stripe-webhook] failed to provision account:', e.message);
    }
  }

  return res.status(200).json({ received: true });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const rawBody = await readRawBody(req);

  // Stripe webhook deliveries carry this header; real checkout-creation
  // requests from our own frontend never do.
  if (req.headers['stripe-signature']) {
    return handleWebhook(req, res, rawBody);
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe key not configured' });

  let body;
  try { body = JSON.parse(rawBody || '{}'); } catch { body = {}; }
  const { plan, successUrl, cancelUrl } = body;

  // Success page reports the finished checkout so the owner hears about it
  // even if the Stripe webhook isn't set up.
  if (body.action === 'confirm') {
    try { await notifyOwnerOnce(body.sessionId); } catch (e) { console.error('[checkout-confirm]', e.message); }
    return res.status(200).json({ ok: true });
  }

  const priceId = PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        'payment_method_types[]': 'card',
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'mode': 'subscription',
        'metadata[plan]': plan,
        'success_url': successUrl || 'https://paypilotai.live/?success=true&session_id={CHECKOUT_SESSION_ID}',
        'cancel_url': cancelUrl || 'https://paypilotai.live/?canceled=true'
      }).toString()
    });

    const session = await response.json();
    if (!response.ok) return res.status(500).json({ error: session.error?.message || 'Stripe error' });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
