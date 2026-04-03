// api/create-checkout.js
// Stripe checkout session — key never touches the browser

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(500).json({ error: 'Stripe key not configured' });

  const { plan, successUrl, cancelUrl } = req.body || {};

  const priceIds = {
    starter: 'price_1THvQx84nVx3JlYAzi3ypSY4',
    pro: 'price_1THvRf84nVx3JlYA7IvOjBHi'
  };

  const priceId = priceIds[plan];
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
        'success_url': successUrl || 'https://paypilot-ai.vercel.app/?success=true',
        'cancel_url': cancelUrl || 'https://paypilot-ai.vercel.app/?canceled=true'
      }).toString()
    });

    const session = await response.json();
    if (!response.ok) return res.status(500).json({ error: session.error?.message || 'Stripe error' });

    return res.status(200).json({ url: session.url });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
