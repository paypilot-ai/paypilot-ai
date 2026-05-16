module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Debug: GET returns current config so you can verify Railway URL
  if (req.method === 'GET') {
    const rawUrl = process.env.RAILWAY_WS_URL || '';
    return res.status(200).json({
      RAILWAY_WS_URL: rawUrl || '(not set — will use TwiML fallback)',
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

    // Check if Railway is reachable; fall back to TwiML if not
    const rawWsUrl = (process.env.RAILWAY_WS_URL || '').trim();
    let mode;

    if (rawWsUrl) {
      const railwayHttp = rawWsUrl.replace(/^wss?:\/\//, 'https://').replace(/^https?:\/\//, 'https://');

      let railwayUp = false;
      try {
        const probe = await fetch(`${railwayHttp}/health`, { signal: AbortSignal.timeout(3000) });
        railwayUp = probe.ok;
      } catch (_) { railwayUp = false; }

      if (railwayUp) {
        // Real-time stream via Railway — uses <Parameter> elements so form data reaches Brandy
        const twimlUrl = `${railwayHttp}/twiml-stream?n=${n}&r=${r}&c=${c}`;
        const response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
          {
            method: 'POST',
            headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ To: e164, From: fromNumber, Url: twimlUrl, Record: 'true' }).toString()
          }
        );
        const data = await response.json();
        if (!response.ok) return res.status(500).json({ error: `Twilio: ${data.message}`, code: data.code, mode: 'realtime' });
        return res.status(200).json({ callSid: data.sid, status: data.status, to: e164, mode: 'realtime' });
      } else {
        console.warn('[ai-call] Railway unreachable at', railwayHttp, '— falling back to TwiML');
        mode = 'twiml-fallback';
      }
    } else {
      mode = 'twiml-fallback';
    }

    // Fallback: Polly TTS + Twilio speech recognition (always works)
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'paypilot-ai.vercel.app';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const twimlUrl = `${proto}://${host}/api/ai-twiml?n=${n}&r=${r}&c=${c}`;

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: e164, From: fromNumber, Url: twimlUrl, Record: 'true' }).toString()
      }
    );
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: `Twilio: ${data.message}`, code: data.code, mode });
    return res.status(200).json({ callSid: data.sid, status: data.status, to: e164, mode });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
