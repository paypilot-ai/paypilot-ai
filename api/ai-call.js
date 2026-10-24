// TEMPORARY: requireAuth() disabled here until AUTH_SECRET etc. are set in
// Vercel/Railway (see loginDemo() in index.html for the matching rollback).
const { rateLimit } = require('../lib/rateLimit');
const { getBearerToken, verifyToken } = require('../lib/sessionAuth');
const { checkAndIncrementDialUsage } = require('../lib/planUsage');
const brandyEmail = require('../lib/brandyEmail');
const liveCall = require('../lib/liveCall');
const leads = require('../lib/leads');
const takeMessage = require('../lib/takeMessage');
const inboundRoute = require('../lib/inboundRoute');

// ElevenLabs agent (Brandy). IDs default to Brandy's; env vars can override them.
const EL_HOSTS = ['https://api.us.elevenlabs.io', 'https://api.elevenlabs.io'];
const elAgentId       = () => (process.env.ELEVENLABS_AGENT_ID || 'agent_8701m5jkzbzfe8ybw4k8qx3vpypk').trim();
const elPhoneNumberId = () => (process.env.ELEVENLABS_PHONE_NUMBER_ID || 'phnum_8701m5myv1fdfkhv648njchgttc4').trim();

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Brandy's follow-up email tool (ElevenLabs calls this mid-call).
  if (req.method === 'POST' && req.query && req.query.action === 'brandy-email') return brandyEmail(req, res);
  // Inbound calls: ElevenLabs asks who Brandy should answer for (see lib/inboundRoute.js).
  if (req.method === 'POST' && req.query && req.query.action === 'inbound-route') return inboundRoute(req, res);
  // Inbound calls: Brandy takes a message and emails it to PayPilot.
  if (req.method === 'POST' && req.query && req.query.action === 'take-message') {
    if (!rateLimit(req, res, { key: 'take-message', limit: 10, windowMs: 60_000 })) return;
    return takeMessage(req, res);
  }
  // "🎧 Listen": fork a live call's audio to Railway so the browser can hear it.
  if (req.method === 'POST' && req.query && req.query.action === 'listen') return liveCall.listen(req, res);
  // Live Assist "Live Call": click-to-call through the rep's phone (see lib/liveCall.js).
  if (req.query && req.query.action === 'live-say') return liveCall.say(req, res);
  if (req.method === 'POST' && req.query && req.query.action === 'live-answered') return liveCall.answered(req, res);
  if (req.method === 'POST' && req.query && req.query.action === 'live-call') {
    if (!rateLimit(req, res, { key: 'live-call', limit: 20, windowMs: 60_000 })) return;
    return liveCall.start(req, res);
  }

  // Captured Leads list (see lib/leads.js).
  if (req.method === 'GET' && req.query && req.query.action === 'leads') return leads.list(req, res);
  if (req.method === 'POST' && req.query && req.query.action === 'leads-delete') {
    if (!rateLimit(req, res, { key: 'leads-delete', limit: 20, windowMs: 60_000 })) return;
    return leads.remove(req, res);
  }

  if (req.method === 'GET') {
    const status = {
      TWILIO_configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER),
      OPENAI_configured: !!process.env.OPENAI_API_KEY,
      ELEVENLABS_configured: !!(process.env.ELEVENLABS_API_KEY || '').trim(),
      code_version: 'brandy-elevenlabs-22',
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
        if (req.query.conv) {
          try {
            const r = await fetch(`${host}/v1/convai/conversations/${encodeURIComponent(String(req.query.conv))}`, { headers: { 'xi-api-key': key } });
            const d = await r.json().catch(() => ({}));
            out.conversation = r.ok ? `ok (paypilot_call=${((d.conversation_initiation_client_data || {}).dynamic_variables || {}).paypilot_call || 'missing'})` : `${r.status}: ${(d.detail && (d.detail.message || d.detail.status)) || d.message || 'error'}`.slice(0, 300);
          } catch (e) { out.conversation = 'network error: ' + e.message; }
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
      // Professional opener: who's calling, the disclosure, then ask for the contact by name.
      const firstName = name.split(/\s+/)[0] || '';
      const greeting = `Hi, this is Brandy with ${company}.${disclosure ? ' ' + disclosure : ''} ${firstName ? `May I speak with ${firstName}, please?` : 'How are you doing today?'}`;
      const prompt = `You are Brandy, calling on behalf of ${company}, speaking live on the phone. You are calling ${name || 'the person who answers'}. This is a live conversation, not a script.

HARD LIMIT ON EVERY TURN: at most 2 short sentences and about 25 words. One idea per turn. If you have more to say, say the first part, check in ("Make sense?" / "With me so far?"), and wait. Long turns are what make you sound like you're reading.

PERSONALITY (this matters as much as the script):
- You're warm, upbeat and genuinely friendly, like someone people enjoy talking to. Smile while you talk.
- React to what they actually say before moving on: "Oh nice," "Ha, I hear you," "Yeah, that makes total sense." Never jump straight to your next point.
- Relate to them. If they mention being busy, a rough day, their team, their kids, the weather, anything, acknowledge it like a real person would and share a quick, natural reaction ("Fridays are always crazy, right?").
- Mirror their energy. Relaxed and chatty with chatty people, quick and to the point with busy ones.
- Use their first name now and then, not every sentence.
- Show you understand their side before you answer an objection: "Totally fair, a lot of people feel that way at first."
- A little light humor is good when they're in a good mood. Never sarcastic, never pushy.
- Sound like a person, not a pitch: contractions, casual words, short sentences.

HOW TO SOUND HUMAN ON THE PHONE (most important):
- The client script is background, not lines to read. Never recite it or copy its wording. Say the gist in your own casual words, the way you'd explain it to a friend.
- Never use written-English constructions like "which is a...", "that offers...", or lists of features. Mention one thing at a time, and only if it fits what they just said.
- Talk in short, loose phrases. Fragments are fine: "Totally." "Oh, for sure." "Yeah, so basically..."
- Use natural spoken starters now and then: "So," "Honestly," "Yeah," "Oh," "Gotcha." An occasional "um" is fine. Don't overdo any of them.
- Vary how you start sentences and how you react. Don't repeat the same phrase twice in a call.
- Keep your energy normal and relaxed, like a friendly person at work, not an excited announcer. Don't gush ("Thanks so much!", "That's wonderful!").
- Plain words only. No emojis, no stage directions, no bracketed tags like [happy], no dashes, no line breaks or paragraphs.
- If the client script is written word for word, treat it as notes. Never say its sentences as written; say each point your own way, in pieces, across several turns.

CLIENT SCRIPT (why you're calling, what you offer, and your goal for this call):
${script}

OPENING: The call has just connected and the person is picking up. Wait for them to say hello, then say exactly: "${greeting}" If they say nothing for a couple of seconds, say it anyway. Never talk over their hello.

HOW TO RUN THE CALL (one step per turn, then stop talking and let them answer):
1. Your opening already asked for the right person. If they confirm, say a brief, polished thank-you ("Great, thanks for taking my call."). If it's someone else, politely ask for the right person or the best time to reach them.
2. Say why you're calling in one clear, professional sentence, then ask one short question to learn whether this is relevant to them. Then wait.
3. Listen for their need or pain point, then connect it to the offer in one sentence.
4. Ask for the next step the client script sets as the goal.
5. If they agree, get their name and email and repeat the email back to confirm.
6. As soon as they confirm the email is right, call the send_follow_up_email tool with that email and their name. Never use the take_message tool on this call.
   - If the tool says the email was sent, tell them it's on its way and end warmly.
   - If the tool returns an error or says it was NOT sent, never claim it was sent. Say someone from ${company} will send it over shortly, and end warmly.

GETTING AN EMAIL OR PHONE NUMBER:
- After you ask for it, say nothing until they have clearly finished. People pause between letters, numbers and "at" or "dot"; a pause is not the end.
- If they stop partway (for example, they haven't said the domain yet), say only "Mm-hm" or "Go ahead" and keep listening.
- When they finish, confirm it casually, not like a form. For an email, spell only the tricky part ("convinced220 at gmail, right?"). For several details, confirm one at a time, each in its own turn.

RULES:
- Sound like a polished professional on a business call: confident, courteous and warm. Never open with filler or apologies like "Do you have thirty seconds?", "I'll be quick", "Sorry to bother you" or "I know you're busy".
- Ask exactly ONE question per turn, and make it the last thing you say. Never stack two questions. Then stop and let them answer.
- Talk like a person, and keep each turn short so they can get a word in.
- Only state facts, prices, and offers that appear in the client script. Never make up numbers, features, integrations, or customer names.
- If you don't know something, say someone from ${company} will follow up with the details. Never guess.
- A clear no means thank them and end the call. Don't push.
- Don't bring up that you're an AI, and don't describe yourself as an assistant, agent or bot. Just introduce yourself as Brandy with ${company}.
- If they ask whether you're an AI, a robot or a real person, answer honestly: yes, you're an AI assistant for ${company}. Then carry on the conversation naturally.`;
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
            pp_account: leads.accountFor(req),   // whose call this is; Captured Leads filters on it
            pp_to: e164,                          // lets a callback from this number reach this customer (lib/inboundRoute.js)
            pp_msg_to: 'none', pp_msg_company: 'none', pp_route_sig: 'none', // used only on inbound calls; must not be empty
            // Signed copy of the follow-up email details (lib/brandyEmail.js). Never empty.
            ...brandyEmail.signEmailDetails({
              c: (companyName || '').trim(), s: (senderEmail || '').trim(), n: name,
              sub: String(emailSubject || '').trim().slice(0, 200), msg: String(emailMessage || '').trim().slice(0, 3000),
            }),
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
