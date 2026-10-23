// TEMPORARY: requireAuth() disabled here until AUTH_SECRET etc. are set in
// Vercel/Railway (see loginDemo() in index.html for the matching rollback).
const { rateLimit } = require('../lib/rateLimit');
const { getBearerToken, verifyToken } = require('../lib/sessionAuth');
const { checkAndIncrementDialUsage } = require('../lib/planUsage');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      TWILIO_configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
      OPENAI_configured: !!process.env.OPENAI_API_KEY,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Only applies to real provisioned customer accounts (a valid signed token,
  // issued after Stripe checkout — see create-checkout.js). The master
  // account currently has no token under the auth rollback, so it's
  // unaffected; this only starts mattering once AUTH_SECRET is configured
  // and a real customer has signed up.
  const tokenPayload = verifyToken(getBearerToken(req));
  const rlIdentifier = tokenPayload ? tokenPayload.sub : undefined;
  if (!rateLimit(req, res, { key: 'ai-call', limit: 20, windowMs: 60_000, identifier: rlIdentifier })) return;

  if (tokenPayload) {
    const usage = checkAndIncrementDialUsage(tokenPayload.sub, tokenPayload.plan);
    if (!usage.allowed) {
      return res.status(402).json({
        error: `You've used all ${usage.limit} AI dials included in your ${tokenPayload.plan} plan this month. Upgrade your plan or contact support for additional dials.`,
      });
    }
  }

  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken  = (process.env.TWILIO_AUTH_TOKEN  || '').trim();
  const fromNumber = (process.env.TWILIO_PHONE_NUMBER || '').trim();

  if (!accountSid || !authToken || !fromNumber) {
    return res.status(500).json({
      error: 'Twilio credentials not configured',
      has_sid: !!accountSid, has_token: !!authToken, has_number: !!fromNumber,
    });
  }

  const { toNumber, customerName, callReason, companyName, customerEmail, senderEmail, returnNumber, language, recordCall, disclosureText } = req.body || {};
  if (!toNumber) return res.status(400).json({ error: 'Phone number required' });

  const cleaned = toNumber.replace(/\D/g, '');
  const e164 = cleaned.startsWith('1') ? '+' + cleaned : '+1' + cleaned;
  const shouldRecord = recordCall !== false; // default true — matches prior always-on behavior

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const name = (customerName || '').trim();
    const n = encodeURIComponent(name);
    const r = encodeURIComponent((callReason || '').slice(0, 500));
    const c = encodeURIComponent(companyName || '');
    const e = encodeURIComponent(customerEmail || '');
    const s = encodeURIComponent(senderEmail || '');
    const rn = encodeURIComponent(returnNumber || '');
    const l = encodeURIComponent(language || 'en');
    const disc = shouldRecord ? encodeURIComponent((disclosureText || '').trim().slice(0, 500)) : '';

    // Preferred: ElevenLabs agent (Brandy). Faster replies, runs several calls at once.
    // Used only when all three env vars are set and the call is in English; otherwise
    // the existing Railway / TwiML paths below run exactly as before.
    const elKey     = (process.env.ELEVENLABS_API_KEY || '').trim();
    const elAgent   = (process.env.ELEVENLABS_AGENT_ID || '').trim();
    const elPhoneId = (process.env.ELEVENLABS_PHONE_NUMBER_ID || '').trim();
    const isEnglish = !language || String(language).toLowerCase().startsWith('en');
    if (elKey && elAgent && elPhoneId && isEnglish) {
      const company = (companyName || '').trim() || 'our team';
      const body = {
        agent_id: elAgent,
        agent_phone_number_id: elPhoneId,
        to_number: e164,
        telephony_call_config: { twilio_call_recording_enabled: shouldRecord },
        conversation_initiation_client_data: {
          dynamic_variables: {
            agent_name: 'Brandy',
            company_name: company,
            customer_name: name || 'the person who answers',
            call_script: (callReason || '').trim().slice(0, 4000) || 'No client script was provided for this call. Say you are calling to briefly follow up, ask if this is a good time, and say someone will reach out with details. Do not describe any product, price, or offer.',
          },
        },
      };
      // Recording disclosure must be spoken up front, so put it in the opening line.
      const disclosure = shouldRecord ? (disclosureText || '').trim().slice(0, 500) : '';
      if (disclosure) {
        body.conversation_initiation_client_data.conversation_config_override = {
          agent: { first_message: `Hi, this is Brandy with ${company}. ${disclosure} Do you have thirty seconds? I'll be quick.` },
        };
      }
      const elResp = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
        method: 'POST',
        headers: { 'xi-api-key': elKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const elData = await elResp.json().catch(() => ({}));
      if (elResp.ok && elData.success !== false && elData.callSid) {
        return res.status(200).json({ callSid: elData.callSid, conversationId: elData.conversation_id, status: 'queued', to: e164, mode: 'elevenlabs' });
      }
      // If ElevenLabs refuses the call, log it and fall through to the old paths so dialing never stops.
      console.error('[ai-call] ElevenLabs outbound failed', elResp.status, elData.message || JSON.stringify(elData.detail || elData));
    }

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
        const twimlUrl = `${railwayHttp}/twiml-stream?n=${n}&r=${r}&c=${c}&e=${e}&s=${s}&rn=${rn}&l=${l}&disc=${disc}`;
        const resp = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
          {
            method: 'POST',
            headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ To: e164, From: fromNumber, Url: twimlUrl, Record: String(shouldRecord), MachineDetection: 'DetectMessageEnd' }).toString()
          }
        );
        const data = await resp.json();
        if (!resp.ok) return res.status(500).json({ error: `Twilio: ${data.message}`, code: data.code, mode: 'realtime' });
        return res.status(200).json({ callSid: data.sid, status: data.status, to: e164, mode: 'realtime' });
      }
    }

    // Fallback: route through ai-twiml.js (uses ElevenLabs TTS, consistent voice)
    const twimlUrl = `https://paypilotai.live/api/ai-twiml?n=${n}&r=${r}&c=${c}&e=${e}&s=${s}&rn=${rn}&disc=${disc}`;
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: e164, From: fromNumber, Url: twimlUrl, Record: String(shouldRecord), MachineDetection: 'DetectMessageEnd' }).toString()
      }
    );
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: `Twilio: ${data.message}`, code: data.code });
    return res.status(200).json({ callSid: data.sid, status: data.status, to: e164, mode: 'twiml' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
