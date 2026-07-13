const fs = require('fs');
const { issueToken, requireAuth } = require('../lib/sessionAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ---- Login (merged here, not a separate file, to stay under Vercel's function limit) ----
  if (req.query.type === 'login' && req.method === 'POST') {
    const { email, password } = req.body || {};
    const e = (email || '').trim().toLowerCase();
    const p = (password || '').trim();
    if (!e || !p) return res.status(400).json({ error: 'Email and password required' });

    const masterEmail = (process.env.MASTER_EMAIL || '').trim().toLowerCase();
    const masterPass = (process.env.MASTER_PASS || '').trim();
    if (masterEmail && masterPass && e === masterEmail && p === masterPass) {
      return res.status(200).json({ token: issueToken(e, 'pro'), plan: 'pro', isLiveUser: true });
    }

    let testerAccounts = [];
    try { testerAccounts = JSON.parse(process.env.TESTER_ACCOUNTS_JSON || '[]'); } catch {}
    const tester = testerAccounts.find(a => (a.email || '').toLowerCase() === e && a.password === p);
    if (tester) {
      return res.status(200).json({ token: issueToken(e, tester.plan || 'pro'), plan: tester.plan || 'pro', isLiveUser: true });
    }

    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (!requireAuth(req, res)) return;

  // ---- Recordings (merged from former api/recordings.js to stay under Vercel's function limit) ----
  if (req.query.type === 'recordings' || req.query.action === 'audio' || req.method === 'DELETE') {
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

      const recs = data.recordings || [];

      // Fetch call details (to number + friendly name) for each unique callSid in parallel
      const uniqueCallSids = [...new Set(recs.map(r => r.call_sid).filter(Boolean))];
      const callMap = {};
      await Promise.all(uniqueCallSids.map(async csid => {
        try {
          const cr = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${csid}.json`,
            { headers: { Authorization: `Basic ${credentials}` } }
          );
          if (cr.ok) {
            const cd = await cr.json();
            callMap[csid] = { to: cd.to, friendlyName: cd.friendly_name || '' };
          }
        } catch {}
      }));

      const recordings = recs.map(rec => ({
        sid:          rec.sid,
        callSid:      rec.call_sid,
        duration:     parseInt(rec.duration, 10) || 0,
        dateCreated:  rec.date_created,
        status:       rec.status,
        toNumber:     callMap[rec.call_sid]?.to || '',
        friendlyName: callMap[rec.call_sid]?.friendlyName || '',
      }));
      return res.status(200).json({ recordings });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST → end a call
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

  // GET ?type=session&sid=XX → proxy Railway session (email capture etc.)
  if (req.query.type === 'session') {
    const { sid } = req.query;
    if (!sid) return res.status(400).json({ error: 'sid required' });
    const rawWsUrl = (process.env.RAILWAY_WS_URL || '').trim();
    if (!rawWsUrl) return res.json({ found: false });
    const railwayHttp = rawWsUrl.replace(/^wss?:\/\//, 'https://');
    try {
      const r = await fetch(`${railwayHttp}/session?callSid=${sid}`, { signal: AbortSignal.timeout(3000) });
      const data = await r.json();
      return res.json(data);
    } catch (e) {
      return res.json({ found: false });
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
