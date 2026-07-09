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

  const { toNumber, customerName, callReason, companyName, customerEmail, senderEmail, language } = req.body || {};
  if (!toNumber) return res.status(400).json({ error: 'Phone number required' });

  const cleaned = toNumber.replace(/\D/g, '');
  const e164 = cleaned.startsWith('1') ? '+' + cleaned : '+1' + cleaned;

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const name = (customerName || '').trim();
    const n = encodeURIComponent(name);
    const r = encodeURIComponent(callReason  || '');
    const c = encodeURIComponent(companyName || '');
    const e = encodeURIComponent(customerEmail || '');
    const s = encodeURIComponent(senderEmail || '');
    const l = encodeURIComponent(language || 'en');

    // Try Railway (OpenAI Realtime + ElevenLabs) first
    const rawWsUrl = (process.env.RAILWAY_WS_URL || '').trim();
    if (rawWsUrl) {
      const railwayHttp = rawWsUrl.replace(/^wss?:\/\//, 'https://');
      let railwayUp = false;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const probe = await fetch(`${railwayHttp}/health`, { signal: ctrl.signal });
        clearTimeout(t);
        railwayUp = probe.ok;
      } catch (_) { railwayUp = false; }

      if (railwayUp) {
        const twimlUrl = `${railwayHttp}/twiml-stream?n=${n}&r=${r}&c=${c}&e=${e}&s=${s}&l=${l}`;
        const resp = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
          {
            method: 'POST',
            headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ To: e164, From: fromNumber, Url: twimlUrl, Record: 'record-from-answer' }).toString()
          }
        );
        const data = await resp.json();
        if (!resp.ok) return res.status(500).json({ error: `Twilio: ${data.message}`, code: data.code, mode: 'realtime' });
        return res.status(200).json({ callSid: data.sid, status: data.status, to: e164, mode: 'realtime' });
      }
    }

    // Fallback: route through ai-twiml.js (uses ElevenLabs TTS, consistent voice)
    const twimlUrl = `https://paypilotai.live/api/ai-twiml?n=${n}&r=${r}&c=${c}&e=${e}&s=${s}`;
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: e164, From: fromNumber, Url: twimlUrl, Record: 'record-from-answer' }).toString()
      }
    );
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: `Twilio: ${data.message}`, code: data.code });
    return res.status(200).json({ callSid: data.sid, status: data.status, to: e164, mode: 'twiml' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
