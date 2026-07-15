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
