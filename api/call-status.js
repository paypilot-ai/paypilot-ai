const fs = require('fs');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // /api/call-status?type=speech&sid=XX  → return speech log
  if (req.query.type === 'speech') {
    const sid = (req.query?.sid || '').replace(/[^A-Za-z0-9]/g, '');
    if (!sid) return res.status(400).json({ text: '', ts: 0 });
    try {
      const raw = fs.readFileSync(`/tmp/speech_${sid}.json`, 'utf8');
      return res.status(200).json(JSON.parse(raw));
    } catch (e) {
      return res.status(200).json({ text: '', ts: 0 });
    }
  }

  // /api/call-status?sid=XX  → return Twilio call status
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
