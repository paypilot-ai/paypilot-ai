// TEMPORARY: requireAuth() disabled here until AUTH_SECRET etc. are set in
// Vercel/Railway (see loginDemo() in index.html for the matching rollback).
const { rateLimit } = require('../lib/rateLimit');
const { getBearerToken, verifyToken } = require('../lib/sessionAuth');
const { checkAndIncrementDialUsage } = require('../lib/planUsage');

// ElevenLabs agent (Brandy). IDs default to Brandy's; env vars can override them.
const EL_HOSTS = ['https://api.us.elevenlabs.io', 'https://api.elevenlabs.io'];
const elAgentId       = () => (process.env.ELEVENLABS_AGENT_ID || 'agent_8701m5jkzbzfe8ybw4k8qx3vpypk').trim();
const elPhoneNumberId = () => (process.env.ELEVENLABS_PHONE_NUMBER_ID || 'phnum_8701m5myv1fdfkhv648njchgttc4').trim();

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const status = {
      TWILIO_configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
      OPENAI_configured: !!process.env.OPENAI_API_KEY,
      ELEVENLABS_configured: !!(process.env.ELEVENLABS_API_KEY || '').trim(),
      code_version: 'brandy-elevenlabs-8',
    };
    // ?check=1 asks ElevenLabs whether the key can see Brandy and her phone
    // number. Read-only: it places no call and never returns the key.
    if (req.query && req.query.check && status.ELEVENLABS_configured) {
      const key = process.env.ELEVENLABS_API_KEY.trim();
      status.elevenlabs_check = {};
      for (const host of EL_HOSTS) {
        const out = {};
        for (const [label, path] of [['agent', `/v1/convai/agents/${elAgentId()}`], ['phone_number', `/v1/convai/phone-numbers/${elPhoneNumberId()}`]]) {
          try {
            const r = await fetch(host + path, { headers: { 'xi-api-key': key } });
            const d = await r.json().catch(() => ({}));
            out[label] = r.ok ? 'ok' : `${r.status}: ${(d.detail && (d.detail.message || d.detail.status || JSON.stringify(d.detail))) || d.message || 'error'}`.slice(0, 300);
          } catch (e) { out[label] = 'network error: ' + e.message; }
        }
        status.elevenlabs_check[host.replace('https://', '')] = out;
      }
    }
    return res.status(200).json(status);
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

  const { toNumber, customerName, callReason, companyName, customerEmail, senderEmail, returnNumber, language, recordCall, disclosureText, emailSubject, emailMessage } = req.body || {};
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
    // Agent and phone IDs default to Brandy's; only ELEVENLABS_API_KEY must be set.
    // Used only when the key is set and the call is in English; otherwise
    // the existing Railway / TwiML paths below run exactly as before.
    const elKey     = (process.env.ELEVENLABS_API_KEY || '').trim();
    const elAgent   = elAgentId();
    const elPhoneId = elPhoneNumberId();
    const isEnglish = !language || String(language).toLowerCase().startsWith('en');
    if (elKey && elAgent && elPhoneId && isEnglish) {
      const company = (companyName || '').trim() || 'our team';
      const script  = (callReason || '').trim().slice(0, 4000)
        || 'No client script was provided for this call. Say you are calling to briefly follow up, ask if this is a good time, and say someone will reach out with details. Do not describe any product, price, or offer.';
      // The agent saved in ElevenLabs is a plain receptionist for inbound calls.
      // Each outbound call sends its own client prompt and greeting here, so no
      // client info is stored in ElevenLabs.
      // Recording disclosure must be spoken up front, so it goes in the opening line.
      const disclosure = shouldRecord ? (disclosureText || '').trim().slice(0, 500) : '';
      const greeting = `Hi, this is Brandy with ${company}.${disclosure ? ' ' + disclosure : ''} Do you have thirty seconds? I'll be quick.`;
      const prompt = `You are Brandy, an AI voice agent calling on behalf of ${company}, speaking live on the phone. You are calling ${name || 'the person who answers'}. Keep most replies to 1-2 short sentences. This is a conversation, not a script.

PERSONALITY (this matters as much as the script):
- You're warm, upbeat and genuinely friendly, like someone people enjoy talking to. Smile while you talk.
- React to what they actually say before moving on: "Oh nice," "Ha, I hear you," "Yeah, that makes total sense." Never jump straight to your next point.
- Relate to them. If they mention being busy, a rough day, their team, their kids, the weather, anything, acknowledge it like a real person would and share a quick, natural reaction ("Fridays are always crazy, right?").
- Mirror their energy. Relaxed and chatty with chatty people, quick and to the point with busy ones.
- Use their first name now and then, not every sentence.
- Show you understand their side before you answer an objection: "Totally fair, a lot of people feel that way at first."
- A little light humor is good when they're in a good mood. Never sarcastic, never pushy.
- Sound like a person, not a pitch: contractions, casual words, short sentences.

CLIENT SCRIPT (why you're calling, what you offer, and your goal for this call):
${script}

OPENING: The call has just connected and the person is picking up. Wait for them to say hello, then say exactly: "${greeting}" If they say nothing for a couple of seconds, say it anyway. Never talk over their hello.

HOW TO RUN THE CALL:
1. Say why you're calling and confirm you're speaking with the right person.
2. Ask one short question to learn whether this is relevant to them.
3. Listen for their need or pain point, then connect it to the offer in one sentence.
4. Ask for the next step the client script sets as the goal.
5. If they agree, get their name and email and repeat the email back to confirm.
6. As soon as they confirm the email is right, call the send_follow_up_email tool with that email and their name, tell them it's on its way, and end warmly.

GETTING AN EMAIL OR PHONE NUMBER:
- After you ask for it, say nothing until they have clearly finished. People pause between letters, numbers and "at" or "dot"; a pause is not the end.
- If they stop partway (for example, they haven't said the domain yet), say only "Mm-hm" or "Go ahead" and keep listening.
- When they finish, read the whole thing back once and ask "Is that right?" If they correct any part, read the corrected version back.

RULES:
- Talk like a person. Ask one question at a time, then stop and listen.
- Only state facts, prices, and offers that appear in the client script. Never make up numbers, features, integrations, or customer names.
- If you don't know something, say someone from ${company} will follow up with the details. Never guess.
- A clear no means thank them and end the call. Don't push.
- If asked whether you're an AI, say yes, you're an AI assistant for ${company}.`;
      const body = {
        agent_id: elAgent,
        agent_phone_number_id: elPhoneId,
        to_number: e164,
        telephony_call_config: { twilio_call_recording_enabled: shouldRecord },
        conversation_initiation_client_data: {
          // Not used in the prompt; api/brandy-email.js reads these back from
          // ElevenLabs to verify the call and build the follow-up email.
          dynamic_variables: {
            paypilot_call: 'yes',
            company_name: (companyName || '').trim(),
            customer_name: name,
            call_reason: (callReason || '').trim().slice(0, 2000),
            sender_email: (senderEmail || '').trim(),
            email_subject: String(emailSubject || '').trim().slice(0, 200),
            email_message: String(emailMessage || '').trim().slice(0, 3000),
          },
          conversation_config_override: {
            agent: { first_message: '', prompt: { prompt } }, // empty first_message = wait for their hello
          },
        },
      };
      // The phone number was imported through ElevenLabs' US servers, so try the
      // US host first and the global host second.
      for (const host of EL_HOSTS) {
        const elResp = await fetch(`${host}/v1/convai/twilio/outbound-call`, {
          method: 'POST',
          headers: { 'xi-api-key': elKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const elData = await elResp.json().catch(() => ({}));
        if (elResp.ok && elData.success !== false && elData.callSid) {
          return res.status(200).json({ callSid: elData.callSid, conversationId: elData.conversation_id, status: 'queued', to: e164, mode: 'elevenlabs' });
        }
        // If ElevenLabs refuses the call, log it and fall through to the old paths so dialing never stops.
        console.error('[ai-call] ElevenLabs outbound failed', host, elResp.status, elData.message || JSON.stringify(elData.detail || elData));
      }
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
