module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe key not configured' });

  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

  try {
    // Retrieve checkout session to get customer ID
    const sessionResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { 'Authorization': 'Bearer ' + key }
    });
    const session = await sessionResp.json();
    if (!sessionResp.ok) return res.status(500).json({ error: session.error?.message || 'Could not retrieve session' });

    const customerId = session.customer;
    if (!customerId) return res.status(400).json({ error: 'No customer found for this session' });

    // Create Customer Portal session — cancellation behaviour (cancel_at_period_end)
    // is configured in the Stripe Dashboard under Billing > Customer portal settings
    const portalResp = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        customer: customerId,
        return_url: 'https://paypilotai.live/'
      }).toString()
    });
    const portal = await portalResp.json();
    if (!portalResp.ok) return res.status(500).json({ error: portal.error?.message || 'Could not create portal session' });

    return res.status(200).json({ url: portal.url });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
