module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken  = (process.env.TWILIO_AUTH_TOKEN  || '').trim();
  const fromNumber = (process.env.TWILIO_PHONE_NUMBER || '').trim();

  if (!accountSid || !authToken || !fromNumber)
    return res.status(500).json({ error: 'Twilio credentials not configured' });

  const { to, message } = req.body || {};
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });

  const cleaned = to.replace(/\D/g, '');
  const e164 = cleaned.startsWith('1') ? '+' + cleaned : '+1' + cleaned;

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: e164, From: fromNumber, Body: message }).toString()
      }
    );
    const data = await resp.json();
    if (!resp.ok) return res.status(500).json({ error: data.message || 'Twilio error' });
    return res.status(200).json({ sid: data.sid, status: data.status });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
