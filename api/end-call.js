module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return res.status(500).json({ error: 'Twilio credentials not configured' });

  const { callSid } = req.body || {};
  if (!callSid) return res.status(400).json({ error: 'callSid required' });

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ Status: 'completed' }).toString()
      }
    );
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.message || 'Twilio error' });
    return res.status(200).json({ success: true, status: data.status });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
