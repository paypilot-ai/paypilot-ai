module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken  = (process.env.TWILIO_AUTH_TOKEN  || '').trim();
  const fromNumber = (process.env.TWILIO_PHONE_NUMBER || '').trim();

  if (!accountSid || !authToken || !fromNumber) {
    return res.status(500).json({
      error: 'Twilio credentials not configured',
      has_sid: !!accountSid,
      has_token: !!authToken,
      has_number: !!fromNumber,
      sid_preview: accountSid ? accountSid.slice(0,6) + '...' : 'MISSING',
      number_preview: fromNumber || 'MISSING'
    });
  }

  const { toNumber, customerName, callReason, companyName } = req.body || {};
  if (!toNumber) return res.status(400).json({ error: 'Phone number required' });

  const cleaned = toNumber.replace(/\D/g, '');
  const e164 = cleaned.startsWith('1') ? '+' + cleaned : '+1' + cleaned;

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const n = customerName || '';
    const r = callReason   || '';
    const c = companyName  || '';

    // Stream audio directly to Railway → OpenAI Realtime (ChatGPT voice quality)
    const railwayUrl = (process.env.RAILWAY_WS_URL || 'wss://paypilot-ai-production.up.railway.app')
      .replace(/^http/, 'ws');
    const streamUrl = `${railwayUrl}/twilio-realtime?n=${encodeURIComponent(n)}&r=${encodeURIComponent(r)}&c=${encodeURIComponent(c)}`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${streamUrl}"/></Connect></Response>`;

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: e164, From: fromNumber, Twiml: twiml }).toString()
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(500).json({
      error: `Twilio ${data.status || response.status}: ${data.message || 'unknown error'} (code ${data.code || 'none'})`,
      sid_used: accountSid.slice(0,6) + '...' + accountSid.slice(-4),
      sid_length: accountSid.length
    });

    return res.status(200).json({ callSid: data.sid, status: data.status, to: e164 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
