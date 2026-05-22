module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken  = (process.env.TWILIO_AUTH_TOKEN  || '').trim();
  if (!accountSid || !authToken)
    return res.status(500).json({ error: 'Twilio credentials not configured' });

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const { action, sid } = req.query;

  // Proxy audio — browser can't hit Twilio directly without credentials
  if (action === 'audio' && sid) {
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${sid}.mp3`;
      const r = await fetch(url, { headers: { Authorization: `Basic ${credentials}` } });
      if (!r.ok) return res.status(r.status).json({ error: 'Recording not found' });
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(buf);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Delete a recording
  if (req.method === 'DELETE' && sid) {
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${sid}.json`;
      await fetch(url, { method: 'DELETE', headers: { Authorization: `Basic ${credentials}` } });
      return res.status(200).json({ deleted: sid });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // List recordings (most recent first, up to 100)
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings.json?PageSize=100`;
    const r = await fetch(url, { headers: { Authorization: `Basic ${credentials}` } });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message });
    const recordings = (data.recordings || []).map(rec => ({
      sid:         rec.sid,
      callSid:     rec.call_sid,
      duration:    parseInt(rec.duration, 10) || 0,
      dateCreated: rec.date_created,
      status:      rec.status,
    }));
    return res.status(200).json({ recordings });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
