module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      TWILIO_configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
      OPENAI_configured: !!process.env.OPENAI_API_KEY,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken  = (process.env.TWILIO_AUTH_TOKEN  || '').trim();
  const fromNumber = (process.env.TWILIO_PHONE_NUMBER || '').trim();

  if (!accountSid || !authToken || !fromNumber) {
    return res.status(500).json({
      error: 'Twilio credentials not configured',
      has_sid: !!accountSid, has_token: !!authToken, has_number: !!fromNumber,
    });
  }

  const { toNumber, customerName, callReason, companyName } = req.body || {};
  if (!toNumber) return res.status(400).json({ error: 'Phone number required' });

  const cleaned = toNumber.replace(/\D/g, '');
  const e164 = cleaned.startsWith('1') ? '+' + cleaned : '+1' + cleaned;

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const n = encodeURIComponent(customerName || '');
    const r = encodeURIComponent(callReason   || '');
    const c = encodeURIComponent(companyName  || '');

    const twimlUrl = `https://paypilot-ai.vercel.app/api/ai-twiml?n=${n}&r=${r}&c=${c}`;

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: e164, From: fromNumber, Url: twimlUrl }).toString()
      }
    );
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: `Twilio: ${data.message}`, code: data.code, twimlUrl });
    return res.status(200).json({ callSid: data.sid, status: data.status, to: e164, mode: 'twiml', twimlUrl });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
