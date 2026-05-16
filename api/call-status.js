const fs = require('fs');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // POST → end a call (previously api/end-call)
  if (req.method === 'POST') {
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
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // GET ?type=speech&sid=XX → return speech log
  if (req.query.type === 'speech') {
    const sid = (req.query?.sid || '').replace(/[^A-Za-z0-9]/g, '');
    if (!sid) return res.status(200).json({ text: '', ts: 0 });
    try {
      const raw = fs.readFileSync(`/tmp/speech_${sid}.json`, 'utf8');
      return res.status(200).json(JSON.parse(raw));
    } catch (e) {
      return res.status(200).json({ text: '', ts: 0 });
    }
  }

  // GET ?sid=XX → return Twilio call status
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) return res.status(500).json({ error: 'Not configured' });

  const { sid } = req.query;
  if (!sid) return res.status(400).json({ error: 'sid required' });

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${sid}.json`,
      { headers: { Authorization: 'Basic ' + credentials } }
    );
    const data = await response.json();
    return res.status(200).json({ status: data.status || 'unknown' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
