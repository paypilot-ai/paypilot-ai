const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const DEEPGRAM_API_KEY  = process.env.DEEPGRAM_API_KEY;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const ELEVENLABS_KEY    = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE  = process.env.ELEVENLABS_VOICE_ID || 'DODLEQrClDo8wCz460ld';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;

// Call Context & Objective often includes an internal negotiation/objection
// script after the offer description — strip that before it reaches the customer.
function summarizeReasonForEmail(reason) {
  if (!reason) return reason;
  const cutMarker = /\b(he|she|they)\s+may\s+say\b|common objections?\s*:|goal\s*:/i;
  const match = cutMarker.exec(reason);
  const summary = (match ? reason.slice(0, match.index) : reason).trim().replace(/[\s,;:—-]+$/, '');
  return summary || reason.trim();
}

function isAcquisitionCall(reason) {
  if (!reason) return false;
  return /acqui(re|sition)|merger|M&A/i.test(reason);
}

// Optional PDF attached to the acquisition follow-up email — commit the file to
// assets/acquisition-overview.pdf to enable; silently omitted if absent.
function getAcquisitionAttachment() {
  try {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'assets', 'acquisition-overview.pdf'));
    return [{ filename: 'PayPilot-AI-Acquisition-Overview.pdf', content: buf.toString('base64') }];
  } catch {
    return undefined;
  }
}

function buildAcquisitionEmail(name) {
  const firstName = (name || 'there').trim().split(/\s+/)[0];
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background:#ffffff;border-radius:12px 12px 0 0;padding:36px 40px 28px;border-bottom:1px solid #e2e8f0;">
    <p style="margin:0 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase;font-weight:600;">From Brandy · PayPilot AI</p>
    <h1 style="margin:0 0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:22px;font-weight:700;color:#0f172a;line-height:1.2;">Hi ${firstName} — here's the info I mentioned</h1>
    <p style="margin:0 0 14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#374151;line-height:1.7;">
      Thanks for taking my call. As promised, I'm sending over the details on PayPilot AI.
      It's a fully built, live AI phone agent platform — and we're exploring acquisition opportunities with the right partner.
    </p>
    <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#374151;line-height:1.7;">
      If this looks like something worth a conversation, just reply to this email and someone from our team will get back to you within 24 hours. No pressure — just wanted to make sure you had the full picture.
    </p>
  </td></tr>
  <tr><td style="background:#ffffff;border-radius:0 0 12px 12px;padding:32px 40px 36px;text-align:center;">
    <p style="margin:0 0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#374151;line-height:1.6;">
      Interested in learning more? Reply to this email and someone from our team will follow up within 24 hours.
    </p>
    <a href="mailto:info@paypilotai.live?subject=PayPilot AI Acquisition Inquiry" style="display:inline-block;background:#0ea5e9;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;">Reply to Connect</a>
    <p style="margin:24px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#94a3b8;">Talk soon,<br/><strong style="color:#64748b;">Brandy</strong> &nbsp;·&nbsp; PayPilot AI &nbsp;·&nbsp; <a href="https://paypilotai.live" style="color:#0ea5e9;text-decoration:none;">paypilotai.live</a></p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  'You are Brandy — a sharp, confident Southern saleswoman on a live outbound call. You close deals. ' +
  'ONE sentence per response — then ask a short question. Always end with a question to keep them talking. Conversational, never scripted. ' +
  'You are always steering toward the close — every response either handles an objection, builds urgency, or asks for the business. ' +
  'Use assumptive language: "When we get you set up..." not "If you decide to..." ' +
  'Create mild urgency naturally — mention limited availability or that others in their area are moving on it. ' +
  'On interest: ask a trial close — "Does that sound like something that would work for you?" ' +
  'On hesitation: dig for the real concern — "What\'s the main thing holding you back?" ' +
  'On price objection: hold firm, reframe the value or ROI. Do NOT drop the price. First no = reframe. Second no = one small concession. Third no = offer to email, warm goodbye [END]. ' +
  'Never apologize for the price. Never say "I know it\'s a lot." Own it — "Yeah, it\'s an investment, and it pays for itself fast." ' +
  'NEVER invent product names, prices, or details you weren\'t given. Only sell what you know. ' +
  'Email given: read it back, confirm you\'ll send something over, keep moving toward the close. ' +
  'AI DISCLOSURE — once the goal is achieved and you are ready to close the call: disclose you are an AI before saying goodbye. Say it naturally: "Oh hey, quick thing — I\'m actually an AI assistant, not a human. [company] uses AI for outreach. Anyway, " then give a warm confident goodbye and [END]. Disclose ONLY after the goal is reached, never before. ' +
  'To end: warm, confident close — "Talk soon!" or "Looking forward to it!" — then [END]. Never [END] without a goodbye. ' +
  'Start replies with: "Yeah", "Look", "So", "Right", "Oh", "Honestly", "I mean" — real talk. ' +
  'Banned words: "Absolutely", "Certainly", "Of course", "I understand", "Great", "Definitely", "No problem", "Sounds good", "I appreciate that", "I get that", "I totally get that", "I hear you", "I can understand", "That makes sense".';

function shouldEndCall(text) {
  return text.toLowerCase().includes('[end]');
}

// Deterministic IVR-menu detection — don't rely on the model noticing "press 1
// for sales" in the transcript and remembering to respond with a press instead
// of talking through it. Runs on the raw transcript before any LLM call.
const IVR_PRESS_RE = /(?:for\s+([a-z][a-z\s]{1,40}?)\s+)?press\s+(pound|star|[0-9]|one|two|three|four|five|six|seven|eight|nine|zero)\b/gi;
const IVR_WORD_DIGIT = { zero:'0', one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9', pound:'#', star:'*' };
const IVR_PRIORITY = ['corporate development', 'strategy', 'merger', 'm&a', 'business development', 'executive office', 'executive', 'operator', 'representative', 'agent'];
function detectIvrDigit(transcript) {
  const matches = [...transcript.matchAll(IVR_PRESS_RE)];
  if (!matches.length) return null;
  const options = matches.map(m => ({
    context: (m[1] || '').toLowerCase().trim(),
    digit: IVR_WORD_DIGIT[m[2].toLowerCase()] || m[2],
  }));
  for (const kw of IVR_PRIORITY) {
    const hit = options.find(o => o.context.includes(kw));
    if (hit) return hit.digit;
  }
  return options[0].digit;
}

// IVR menus almost always open with a preamble before ever saying "press N" —
// "Thank you for calling X, your call may be recorded..." Without recognizing
// this, that preamble reads as a live person answering and Brandy talks right
// over the rest of the menu before it lists any options.
const IVR_PREAMBLE_RE = /\b(thank you for calling|welcome to|your call (is important|may be (recorded|monitored))|please listen (carefully|closely)|menu options have changed|all (of )?our (representatives|agents|operators|lines) are (currently )?(busy|assisting)|please (continue to )?hold|please stay on the line|for quality (assurance|purposes)|to repeat this menu|if you know your party.?s extension|enter your party.?s extension|main menu|para espa(ñ|n)ol|is currently closed|business hours are|leave a message after the tone)\b/i;
function looksAutomated(transcript) {
  return !!detectIvrDigit(transcript) || IVR_PREAMBLE_RE.test(transcript);
}

function hangupCall(session) {
  callLog(session.callSid, '[hangup] ending call via REST + WebSocket');
  // Twilio REST API — most reliable way to end the call
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && session.callSid) {
    const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${session.callSid}.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'Status=completed'
    }).then(r => callLog(session.callSid, '[hangup] REST status:', r.status))
      .catch(e => callLog(session.callSid, '[hangup] REST error:', e.message));
  }
  // Also close WebSocket as backup
  setTimeout(() => { try { session.twilioWs?.close(); } catch {} }, 2000);
}
const LANG_NAMES = { en:'English', es:'Spanish', pt:'Portuguese', fr:'French', zh:'Mandarin Chinese', vi:'Vietnamese', ko:'Korean', ar:'Arabic', hi:'Hindi', ht:'Haitian Creole' };

// Calls only end when the model emits [END] — these caps stop a call from
// running away if the model never reaches that on its own.
const MAX_CALL_DURATION_MS = 6 * 60 * 1000;
const MAX_ASSISTANT_TURNS  = 16;

function buildSystemPrompt(session) {
  const base = session.prompt || SYSTEM_PROMPT;
  const parts = [base];
  if (session.company) parts.push(`You are calling on behalf of ${session.company}.`);
  const shortReason = session.reason ? summarizeReasonForEmail(session.reason) : '';
  if (shortReason) {
    parts.push(`The reason for this call, in plain customer-facing terms: ${shortReason}. When you state why you're calling, say it plainly and specifically — never vague filler. Get to the point fast; the customer should know exactly why you called within your first response.`);
  }
  if (session.reason) parts.push(`Full background/strategy notes for this call (for your own context only — use to guide objections and negotiation, do NOT recite verbatim or read this to the customer): ${session.reason}.`);
  if (session.name) {
    const cleanName = session.name.trim().split(/[,\-—|]/)[0].trim().split(/\s+/).slice(0, 2).join(' ');
    parts.push(`You are speaking with ${cleanName}.`);
  }
  parts.push('Never mention the contact\'s job title, role, or any internal metadata — address them by first name only.');
  if (session.language && session.language !== 'en') {
    const langName = LANG_NAMES[session.language] || session.language;
    parts.push(`IMPORTANT: Conduct this entire call in ${langName}. Greet, respond, and close entirely in ${langName}.`);
  }
  parts.push('NEGOTIATION RULES: Always start at the rate or price you were given and hold it. Never volunteer a lower number or your floor — only come down if they explicitly push back. Concede one small step at a time. Do not give away your bottom line.');
  parts.push('IVR NAVIGATION: If you hear an automated phone menu (e.g. "press 1 for sales", "for billing press 2", "please listen to our menu options"), you MUST navigate it — do NOT speak. Output ONLY [PRESS:X] where X is the best digit: prefer any option for "corporate development", "strategy", "M&A", "business development", or "executive office"; otherwise press 0 for an operator. Never say anything when pressing a key — just [PRESS:X] by itself.');
  if (session.history.filter(m => m.role === 'assistant').length === 0) {
    parts.push('This is the very start of the call — you have not spoken yet, but they already answered the phone and said something first. Respond briefly and naturally to what they said (don\'t ignore it), then introduce yourself, your company, and state plainly and specifically why you\'re calling — one short, concrete phrase, never vague filler. Ask if they have a sec. Do NOT ask "may I speak with" them if they already indicated they are the right person.');
  }
  if (session.history.filter(m => m.role === 'assistant').length >= MAX_ASSISTANT_TURNS - 3) {
    parts.push('This call has gone on long enough — wrap it up in your next response: give a warm goodbye and [END]. Do not ask another question or start a new topic.');
  }
  return parts.join(' ');
}

async function sendDTMF(session, digit) {
  const accountSid = TWILIO_ACCOUNT_SID;
  const authToken  = TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken || !session.callSid) return;
  const host = process.env.RAILWAY_PUBLIC_DOMAIN || '';
  if (!host) { callLog(session.callSid, '[dtmf] skipped — RAILWAY_PUBLIC_DOMAIN not set'); return; }

  const wsUrl = `wss://${host}/twilio`;
  const paramXml = [
    session.name          ? `<Parameter name="n" value="${xmlEsc(session.name)}"/>` : '',
    session.reason        ? `<Parameter name="r" value="${xmlEsc(session.reason.slice(0, 500))}"/>` : '',
    session.company       ? `<Parameter name="c" value="${xmlEsc(session.company)}"/>` : '',
    session.capturedEmail ? `<Parameter name="e" value="${xmlEsc(session.capturedEmail)}"/>` : '',
    session.senderEmail   ? `<Parameter name="s" value="${xmlEsc(session.senderEmail)}"/>` : '',
    session.language      ? `<Parameter name="l" value="${xmlEsc(session.language)}"/>` : '',
  ].join('');
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="${digit}"/><Connect><Stream url="${wsUrl}">${paramXml}</Stream></Connect></Response>`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${session.callSid}.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ Twiml: twiml }).toString()
    });
    callLog(session.callSid, '[dtmf] pressed', digit, '— Twilio status:', r.status);
  } catch (e) {
    callLog(session.callSid, '[dtmf] error:', e.message);
  }
}

function sendForm(session) {
  if (!session.capturedEmail || session.docuSignSent || !FORM_LINK) return;
  session.docuSignSent = true;
  callLog(session.callSid, '[form] sending to', session.capturedEmail);
  fetch('https://paypilot-ai.vercel.app/api/send-agreement', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: session.name || '',
      customerEmail: session.capturedEmail,
      callReason: session.reason || '',
      senderEmail: session.senderEmail || '',
      subject: 'Your Form — Please Review',
      message: `Hi${session.name ? ' ' + session.name : ''},\n\nAs discussed on our call, here is the form for you to review.\n\nIf you have any questions, feel free to reply to this email.`,
      docuSignLink: FORM_LINK
    })
  }).then(r => r.json()).then(d => {
    callLog(session.callSid, '[form] sent:', d.ok ? 'ok' : d.error);
    pushToBrowser(session, { event: 'docusign-sent', email: session.capturedEmail });
  }).catch(e => callLog(session.callSid, '[form] error:', e.message));
}

const sessions = new Map();

// Per-call debug log ring buffer (last 30 entries per call, last 20 calls)
const callLogs = new Map();
function callLog(callSid, ...args) {
  const msg = args.join(' ');
  console.log('[' + (callSid || '?').slice(-6) + ']', msg);
  if (!callLogs.has(callSid)) {
    if (callLogs.size >= 20) callLogs.delete(callLogs.keys().next().value);
    callLogs.set(callSid, []);
  }
  const arr = callLogs.get(callSid);
  arr.push({ t: new Date().toISOString(), msg });
  if (arr.length > 50) arr.shift();
}

app.get('/health', (req, res) => res.json({ ok: true, activeCalls: sessions.size }));

app.get('/session', (req, res) => {
  const sid = req.query.callSid;
  const session = sid ? sessions.get(sid) : null;
  if (!session) return res.json({ found: false });
  res.json({ found: true, capturedEmail: session.capturedEmail || null, docuSignSent: session.docuSignSent || false, state: session.state });
});

app.get('/logs', (req, res) => {
  const out = {};
  for (const [sid, entries] of callLogs) out[sid] = entries;
  res.json(out);
});

app.get('/voices', async (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  if (!ELEVENLABS_KEY) return res.status(500).json({ error: 'No ElevenLabs key' });
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': ELEVENLABS_KEY }
    });
    const data = await r.json();
    let voices = (data.voices || []).map(v => ({
      id: v.voice_id, name: v.name,
      description: v.description || '',
      labels: v.labels || {},
      preview_url: v.preview_url
    }));
    if (search) voices = voices.filter(v =>
      v.name.toLowerCase().includes(search) ||
      v.description.toLowerCase().includes(search) ||
      JSON.stringify(v.labels).toLowerCase().includes(search)
    );
    res.json({ count: voices.length, voices });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function xmlEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildVoicemail(n, c, r) {
  const firstName = n ? n.trim().split(/\s+/)[0] : '';
  const company = c || 'PayPilot AI';
  const reason = r ? r.slice(0, 200) : 'a quick call';
  return `Hi${firstName ? ' ' + firstName : ''}, this is Brandy calling from ${company} about ${reason}. Sorry I missed you — feel free to give us a call back, or I'll try you again soon. Thanks, have a great day!`;
}

app.all('/twiml-stream', (req, res) => {
  const n = req.query.n || '';
  const r = req.query.r || '';
  const c = req.query.c || '';
  const e = req.query.e || '';
  const s = req.query.s || '';
  const l = req.query.l || 'en';
  const host = process.env.RAILWAY_PUBLIC_DOMAIN ||
               req.headers['x-forwarded-host'] ||
               req.headers.host || '';
  console.log('[twiml-stream] host:', host, 'n:', n, 'r:', r, 'c:', c, 'e:', e ? '(set)' : '(none)', 's:', s ? '(set)' : '(none)', 'lang:', l, 'method:', req.method);

  // Answering-machine detection (Twilio MachineDetection=Enable on the call) —
  // leave a short voicemail instead of connecting the real-time stream.
  const answeredBy = (req.body?.AnsweredBy || req.query.AnsweredBy || '').trim();
  if (answeredBy.startsWith('machine') || answeredBy === 'fax') {
    console.log('[twiml-stream] AnsweredBy:', answeredBy, '— leaving voicemail');
    res.setHeader('Content-Type', 'text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">${xmlEsc(buildVoicemail(n, c, r))}</Say><Hangup/></Response>`);
  }

  const wsUrl = `wss://${host}/twilio`;
  // Pass params as Twilio <Parameter> elements — reliable, no URL-encoding edge cases
  const paramXml = [
    n ? `<Parameter name="n" value="${xmlEsc(n)}"/>` : '',
    r ? `<Parameter name="r" value="${xmlEsc(r)}"/>` : '',
    c ? `<Parameter name="c" value="${xmlEsc(c)}"/>` : '',
    e ? `<Parameter name="e" value="${xmlEsc(e)}"/>` : '',
    s ? `<Parameter name="s" value="${xmlEsc(s)}"/>` : '',
    l ? `<Parameter name="l" value="${xmlEsc(l)}"/>` : '',
  ].join('');
  res.setHeader('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${wsUrl}">${paramXml}</Stream></Connect></Response>`);
});

app.get('/test-realtime', (req, res) => {
  const ws = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );
  const timeout = setTimeout(() => { ws.close(); res.json({ realtime: 'TIMEOUT' }); }, 6000);
  ws.on('open', () => { clearTimeout(timeout); ws.close(); res.json({ realtime: 'OK — connected successfully' }); });
  ws.on('error', e => { clearTimeout(timeout); res.json({ realtime: 'ERROR: ' + e.message }); });
});

app.get('/debug-session', (req, res) => {
  const events = [];
  const ws = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
  );
  const done = (result) => { try { ws.close(); } catch {} res.json(result); };
  const timeout = setTimeout(() => done({ error: 'TIMEOUT', events }), 8000);
  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        audio: {
          input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' } },
          output: { format: { type: 'audio/pcmu' }, voice: 'coral' }
        }
      }
    }));
  });
  ws.on('message', raw => {
    const ev = JSON.parse(raw);
    events.push({ type: ev.type, error: ev.error, keys: Object.keys(ev) });
    if (ev.type === 'session.updated') {
      ws.send(JSON.stringify({
        type: 'response.create',
        response: { output_modalities: ['audio'], instructions: 'Say hello briefly.' }
      }));
    }
    if (ev.type === 'response.audio.delta' || ev.type === 'response.done' || ev.type === 'error' || events.length >= 12) {
      clearTimeout(timeout);
      done({ events });
    }
  });
  ws.on('error', e => { clearTimeout(timeout); done({ wsError: e.message, events }); });
});

app.get('/echo-params', (req, res) => {
  const n = req.query.n || '(empty)';
  const r = req.query.r || '(empty)';
  const c = req.query.c || '(empty)';
  res.json({ received: { name: n, reason: r, company: c }, raw_query: req.query });
});

app.get('/test', async (req, res) => {
  const results = {
    env: {
      DEEPGRAM_API_KEY:  !!process.env.DEEPGRAM_API_KEY,
      OPENAI_API_KEY:    !!process.env.OPENAI_API_KEY,
      ELEVENLABS_API_KEY:!!process.env.ELEVENLABS_API_KEY,
      ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || '(not set)',
      RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN || '(not set)'
    },
    openai: null,
    elevenlabs: null,
    deepgram: null
  };
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Say "ok"' }], max_tokens: 5 })
    });
    const d = await r.json();
    results.openai = r.ok ? 'OK: ' + d.choices?.[0]?.message?.content : 'ERROR: ' + JSON.stringify(d);
  } catch (e) { results.openai = 'EXCEPTION: ' + e.message; }
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test', model_id: ELEVENLABS_VOICE_SETTINGS.model_id, output_format: 'pcm_16000' })
    });
    results.elevenlabs = r.ok ? 'OK' : 'ERROR: ' + await r.text();
  } catch (e) { results.elevenlabs = 'EXCEPTION: ' + e.message; }
  try {
    const dgWs = new WebSocket(
      'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2',
      { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
    );
    results.deepgram = await new Promise(resolve => {
      dgWs.on('open', () => { dgWs.close(); resolve('OK — connected'); });
      dgWs.on('error', e => resolve('ERROR: ' + e.message));
      dgWs.on('close', (code, reason) => {
        if (results.deepgram === null) resolve('CLOSED immediately: ' + code + ' ' + (reason?.toString() || ''));
      });
      setTimeout(() => { try { dgWs.terminate(); } catch {} resolve('TIMEOUT after 5s'); }, 5000);
    });
  } catch (e) { results.deepgram = 'EXCEPTION: ' + e.message; }
  res.json(results);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  console.log('[ws] connection:', url.pathname);
  if (url.pathname === '/ws-test') {
    ws.send(JSON.stringify({ ok: true, msg: 'WebSocket connection works' }));
    ws.close();
  } else if (url.pathname === '/twilio') {
    handleTwilio(ws);
  } else if (url.pathname === '/twilio-realtime') {
    try { handleTwilioRealtime(ws); }
    catch (e) { console.error('[realtime] crash on connect:', e.message, e.stack); ws.close(); }
  } else if (url.pathname === '/browser') {
    handleBrowser(ws, url.searchParams.get('callSid'));
  } else {
    ws.close(1008, 'Unknown path');
  }
});

function handleTwilio(ws) {
  let session = null;
  let dgAudioLogged = false;
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.event === 'start') {
      const callSid   = msg.start.callSid;
      const streamSid = msg.start.streamSid;
      const cp = msg.start?.customParameters || {};
      const n = cp.n || '';
      const r = cp.r || '';
      const c = cp.c || '';
      const e = cp.e || '';
      const s = cp.s || '';
      const l = cp.l || 'en';

      // Reconnect after DTMF — preserve existing session history and state
      const existing = sessions.get(callSid);
      if (existing) {
        existing.streamSid = streamSid;
        existing.twilioWs = ws;
        existing.ttsAbort = null;
        session = existing;
        dgAudioLogged = false;
        callLog(callSid, '[call] reconnected after DTMF, history preserved');
        connectDeepgram(session);
        if (session.state === 'greeting') armIntroListen(session);
        return;
      }

      session = { callSid, streamSid, twilioWs: ws, browserWs: null, dgWs: null, markResolvers: {}, ttsAbort: null, bargedIn: false, greetingTimer: null, introAttempts: 0, state: 'greeting', speakGen: 0, turnId: 0, history: [], prompt: null, name: n, company: c, reason: r, language: l, capturedEmail: e || null, emailFromSpeech: false, senderEmail: s || null, docuSignSent: false, emailSent: false, startedAt: Date.now() };
      sessions.set(callSid, session);
      dgAudioLogged = false;
      callLog(callSid, '[call] started | name:', n || '(none)', '| company:', c || '(none)', '| voice:', ELEVENLABS_VOICE);
      connectDeepgram(session);
      armIntroListen(session);
    }
    if (msg.event === 'media' && session) {
      const dgState = session.dgWs?.readyState;
      if (dgState === WebSocket.OPEN) {
        if (!dgAudioLogged) { callLog(session.callSid, '[dg] first audio packet sent to Deepgram'); dgAudioLogged = true; }
        session.dgWs.send(Buffer.from(msg.media.payload, 'base64'));
      } else if (dgState !== WebSocket.CONNECTING && !session.dgReconnecting) {
        callLog(session.callSid, '[dg] was closed — reconnecting (state was', dgState + ')');
        session.dgReconnecting = true;
        dgAudioLogged = false;
        connectDeepgram(session);
      }
    }
    if (msg.event === 'mark' && session) {
      const name = msg.mark?.name;
      if (name && session.markResolvers?.[name]) {
        callLog(session.callSid, '[mark] received:', name);
        session.markResolvers[name]();
        delete session.markResolvers[name];
      }
    }
    if (msg.event === 'stop' && session) {
      callLog(session.callSid, '[call] ended');
      cleanup(session);
      sessions.delete(session.callSid);
    }
  });
  ws.on('close', () => { if (session) { sendFollowUpEmailLegacy(session); cleanup(session); sessions.delete(session.callSid); } });
}

function sendFollowUpEmailLegacy(session) {
  if (!session || !session.capturedEmail || session.emailSent) return;
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('[email] skipped — RESEND_API_KEY not set'); return; }
  session.emailSent = true;
  const firstName = (session.name || 'there').trim().split(/\s+/)[0];
  const company   = session.company  || 'PayPilot AI';
  const fromEmail = process.env.FROM_EMAIL || 'info@paypilotai.live';
  const fromName  = process.env.FROM_NAME  || 'PayPilot AI';

  let subject, html, attachments;
  if (isAcquisitionCall(session.reason)) {
    subject = 'PayPilot AI — Acquisition Overview';
    html = buildAcquisitionEmail(firstName);
    attachments = getAcquisitionAttachment();
  } else {
    const reason = session.reason ? summarizeReasonForEmail(session.reason) : 'our conversation today';
    subject = `Following up from our call — ${company}`;
    html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;"><h2 style="color:#0f172a;">Hi ${firstName},</h2><p style="color:#374151;font-size:16px;line-height:1.7;">Thanks so much for chatting today! As promised, I'm following up about ${reason}. If you have any questions or want to move forward, just reply to this email — I'd love to help.</p><p style="color:#64748b;font-size:14px;margin-top:28px;">Talk soon,<br/>Brandy<br/>${company}</p></div>`;
  }

  console.log('[email] sending to:', session.capturedEmail);
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [session.capturedEmail],
      reply_to: session.senderEmail || fromEmail,
      subject,
      html,
      attachments,
    }),
  }).then(async r => { const b = await r.text(); console.log('[email] Resend:', r.status, b.slice(0, 200)); })
    .catch(e => console.error('[email] error:', e.message));
}

function handleBrowser(ws, callSid) {
  if (callSid && sessions.has(callSid)) {
    sessions.get(callSid).browserWs = ws;
    ws.send(JSON.stringify({ event: 'connected', callSid }));
  }
  ws.on('close', () => { if (callSid && sessions.has(callSid)) sessions.get(callSid).browserWs = null; });
}

const LANG_TO_DG = { en:'en-US', es:'es', pt:'pt-BR', fr:'fr', zh:'zh-CN', vi:'vi', ko:'ko', ar:'ar', hi:'hi', ht:'fr-HT' };

function connectDeepgram(session) {
  const dgLang = LANG_TO_DG[session.language || 'en'] || 'en-US';
  const dgUrl = 'wss://api.deepgram.com/v1/listen' +
    '?encoding=mulaw&sample_rate=8000&channels=1' +
    `&model=nova-2-phonecall&punctuate=true&language=${dgLang}` +
    '&interim_results=false&endpointing=500&vad_events=true';
  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
  session.dgWs = dg;
  dg.on('open', () => {
    if (session.dgWs !== dg) return;
    callLog(session.callSid, '[dg] connected');
    session.dgReconnecting = false;
  });
  dg.on('message', async (data) => {
    if (session.dgWs !== dg) return;
    try {
      const result = JSON.parse(data);
      if (result.type === 'SpeechStarted') return;

      const transcript = result?.channel?.alternatives?.[0]?.transcript?.trim();
      const confidence = result?.channel?.alternatives?.[0]?.confidence ?? 1;
      if (!transcript || !result.is_final) return;
      // Automated/synthetic IVR menu voices often score lower confidence than natural
      // speech — don't drop them before we've even had a chance to check for a menu.
      if (confidence < 0.80 && session.state !== 'greeting') {
        callLog(session.callSid, '[dg] low confidence (' + confidence.toFixed(2) + '), skipping:', transcript);
        return;
      }
      const words = transcript.split(/\s+/).filter(Boolean);
      // Only filter noise mid-conversation — never filter the first response to the greeting
      const isFirstResponse = session.history.filter(m => m.role === 'user').length === 0;
      if (!isFirstResponse) {
        // Single-word filler sounds
        const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|hm+|huh|mhm|ah+|oh+|ow+|ha+|eh+|er+|ugh+|ooh+|yep|nope|nah|ew+|wow|whoa)\s*[.?!]?$/i;
        // Two-word noise combos
        const TWO_WORD_NOISE = /^(uh (huh|oh|yeah|ok|okay|hm)|oh (ok|okay|wow|hmm|really)|mm (hmm|yeah|ok)|oh my|my god|oh god)[.?!]?$/i;
        if (words.length < 1
          || NOISE_ONLY.test(transcript)
          || (words.length === 2 && TWO_WORD_NOISE.test(transcript))
          || (words.length < 3 && /^[^a-zA-Z]*$/.test(transcript))) {
          callLog(session.callSid, '[dg] filtered noise:', transcript);
          return;
        }
      }
      callLog(session.callSid, '[prospect]', transcript, '| state:', session.state);
      pushToBrowser(session, { event: 'transcript', speaker: 'prospect', text: transcript });

      // Capture email address if spoken by prospect
      const emailMatch = transcript.match(/\b[a-zA-Z0-9._%+\-]+\s*[@at]+\s*[a-zA-Z0-9.\-]+\s*\.\s*(?:com|net|org|edu|gov|io|co)\b/i);
      if (emailMatch && !session.capturedEmail) {
        const rawEmail = emailMatch[0].replace(/\s+/g, '').replace(/\bat\b/gi, '@');
        session.capturedEmail = rawEmail;
        session.emailFromSpeech = true;
        callLog(session.callSid, '[email] captured from speech:', rawEmail);
        pushToBrowser(session, { event: 'email-captured', email: rawEmail });
      }

      if (session.state === 'greeting') {
        const ivrDigit = detectIvrDigit(transcript);
        if (ivrDigit) {
          clearTimeout(session.greetingTimer);
          callLog(session.callSid, '[dtmf] IVR pattern detected before greeting — pressing', ivrDigit);
          sendDTMF(session, ivrDigit); // reconnect re-arms the intro listen window
          return;
        }
        if (IVR_PREAMBLE_RE.test(transcript)) {
          // Automated system is still talking (preamble/hold message, no digit yet) — keep listening.
          callLog(session.callSid, '[intro] automated system preamble, no digit yet — keep listening:', transcript.slice(0, 60));
          armIntroListen(session);
          return;
        }
        // Doesn't look like a menu — a live person answered. Let the model respond
        // to what they actually said instead of talking over it with a fixed script.
        clearTimeout(session.greetingTimer);
        session.state = 'processing';
        session.history.push({ role: 'user', content: transcript });
        generateAndSpeak(session).catch(e => {
          callLog(session.callSid, '[ai] intro error:', e.message);
          session.state = 'listening';
        });
        return;
      }
      if (session.state === 'processing') { return; }
      if (session.state === 'speaking') {
        const elapsed = session.speakStartTime ? Date.now() - session.speakStartTime : 0;
        // Allow barge-in only after 2s — echo from Brandy's own audio hits Deepgram
        // immediately; real interruptions from the prospect happen after she's been talking a bit
        if (elapsed > 2000) {
          callLog(session.callSid, '[barge-in] cutting Brandy off:', transcript);
          if (session.twilioWs?.readyState === WebSocket.OPEN)
            session.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
          session.pendingTranscript = null;
          ++session.speakGen;
          ++session.turnId;
          session.state = 'processing';
          session.history.push({ role: 'user', content: transcript });
          generateAndSpeak(session).catch(e => {
            callLog(session.callSid, '[ai] barge-in error:', e.message);
            session.state = 'listening';
          });
          return;
        }
        session.pendingTranscript = transcript;
        callLog(session.callSid, '[dg] queued during speech (echo window):', transcript);
        return;
      }
      if (session.state === 'ending') return; // call is wrapping up — ignore everything
      if (session.state !== 'listening') {
        session.pendingTranscript = transcript;
        callLog(session.callSid, '[dg] buffered (state=' + session.state + '):', transcript);
        return;
      }
      session.pendingTranscript = null;
      session.state = 'processing';
      session.history.push({ role: 'user', content: transcript });
      await generateAndSpeak(session);
    } catch (e) { callLog(session.callSid, '[dg] message error:', e.message); }
  });
  dg.on('unexpected-response', (req, res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => callLog(session.callSid, `[dg] 400 response: ${body.slice(0, 200)}`));
  });
  dg.on('error', (e) => callLog(session.callSid, '[dg] error:', e.message));
  dg.on('close', (code) => {
    if (session.dgWs !== dg) return;
    callLog(session.callSid, '[dg] closed, code:', code);
    session.dgReconnecting = false;
  });
}

function buildGreeting(name, company, reason) {
  if (name) {
    const firstName = name.trim().split(/\s+/)[0];
    return `Hi, may I speak with ${firstName}?`;
  }
  const c = company || 'PayPilot AI';
  return `Hi there, this is Brandy calling from ${c}. Who am I speaking with?`;
}

async function sendGreeting(session) {
  const greeting = buildGreeting(session.name, session.company, session.reason);
  session.history.push({ role: 'assistant', content: greeting });
  pushToBrowser(session, { event: 'ai-response', text: greeting });
  await speakToTwilio(session, greeting);

  // Safety net: give 7s AFTER greeting finishes for prospect to respond
  setTimeout(() => {
    const userTurns = session.history.filter(m => m.role === 'user').length;
    if (userTurns === 0 && session.state === 'listening') {
      callLog(session.callSid, '[greeting] no response — re-pinging');
      const nudge = session.name ? `${session.name.trim().split(' ')[0]}?` : 'Hello?';
      session.history.push({ role: 'assistant', content: nudge });
      speakToTwilio(session, nudge);
    }
  }, 7000);
}

// Many calls are answered by an automated phone menu that starts talking
// immediately — listen silently first instead of speaking the greeting over it.
// If what we hear looks like an IVR menu, press through it (re-arming this same
// listen window for the next menu level) without ever speaking; otherwise proceed
// with the normal greeting.
function armIntroListen(session) {
  clearTimeout(session.greetingTimer);
  session.introAttempts = (session.introAttempts || 0) + 1;
  session.greetingTimer = setTimeout(() => {
    if (session.state === 'greeting') sendGreeting(session);
  }, session.introAttempts > 10 ? 0 : 3500);
}


async function generateAndSpeak(session) {
  const myTurn = ++session.turnId;
  callLog(session.callSid, '[ai] generating response (turn=' + myTurn + ')...');

  if (Date.now() - session.startedAt > MAX_CALL_DURATION_MS) {
    callLog(session.callSid, '[call] hit max duration cap — forcing hangup');
    const goodbye = "Hey, I've got to hop on another call — really appreciate your time today, talk soon!";
    session.history.push({ role: 'assistant', content: goodbye });
    pushToBrowser(session, { event: 'ai-response', text: goodbye });
    await speakToTwilio(session, goodbye);
    session.state = 'ending';
    pushToBrowser(session, { event: 'call-ended' });
    sendFollowUpEmailLegacy(session);
    hangupCall(session);
    return;
  }

  const lastUserMsg = [...session.history].reverse().find(m => m.role === 'user');
  const ivrDigit = lastUserMsg ? detectIvrDigit(lastUserMsg.content) : null;
  if (ivrDigit) {
    callLog(session.callSid, '[dtmf] IVR pattern detected in transcript — pressing', ivrDigit);
    session.state = 'listening';
    await sendDTMF(session, ivrDigit);
    return;
  }

  const messages = [{ role: 'system', content: buildSystemPrompt(session) }, ...session.history.slice(-12)];

  session.state = 'speaking';
  session.speakStartTime = Date.now();

  let fullReply;
  try {
    fullReply = await streamOpenAIAndSpeak(session, messages, myTurn);
  } catch (e) {
    callLog(session.callSid, '[ai] generateAndSpeak error:', e.message);
    if (session.turnId === myTurn) enterListening(session);
    return;
  }

  // If a real barge-in happened (new transcript arrived), discard this response.
  // The new generateAndSpeak will call enterListening when it's done.
  if (session.turnId !== myTurn) {
    callLog(session.callSid, '[ai] turn superseded by barge-in, discarding reply');
    return;
  }

  const SCRIPTED_FALLBACK = [
    'So what does your situation look like right now?',
    'What\'s the main thing holding you back?',
    'Can I shoot you a quick email with the details?',
  ];
  if (!fullReply) {
    const fb = SCRIPTED_FALLBACK[Math.min(session.history.filter(m => m.role === 'assistant').length, SCRIPTED_FALLBACK.length - 1)];
    session.history.push({ role: 'assistant', content: fb });
    await speakToTwilio(session, fb);
    return;
  }

  const pressMatch = fullReply.match(/\[PRESS:([0-9#*])\]/i);
  const cleanReply = fullReply.replace(/\[END\]/gi, '').replace(/\[PRESS:[0-9#*]\]/gi, '').trim();
  callLog(session.callSid, '[ai] reply:', cleanReply.slice(0, 80));
  session.history.push({ role: 'assistant', content: cleanReply });
  pushToBrowser(session, { event: 'ai-response', text: cleanReply });

  // Auto-send DocuSign only when email was captured from speech during this call — fire and forget
  if (session.capturedEmail && session.emailFromSpeech && !session.docuSignSent && !shouldEndCall(fullReply)) {
    session.docuSignSent = true;
    callLog(session.callSid, '[docusign] sending agreement to', session.capturedEmail);
    fetch('https://paypilot-ai.vercel.app/api/send-agreement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: session.name || '',
        customerEmail: session.capturedEmail,
        callReason: session.reason || 'follow-up call',
        subject: 'Your Agreement — Please Review & Sign',
        message: `Hi${session.name ? ' ' + session.name : ''},\n\nThank you for speaking with Brandy today! Please review and sign your agreement using the link below.\n\nIf you have any questions, feel free to reply to this email.`,
        docuSignLink: 'https://www.docusign.com'
      })
    }).then(r => r.json()).then(d => {
      callLog(session.callSid, '[docusign] sent:', d.ok ? 'ok' : d.error);
      pushToBrowser(session, { event: 'docusign-sent', email: session.capturedEmail });
    }).catch(e => callLog(session.callSid, '[docusign] send failed:', e.message));
  }

  if (shouldEndCall(fullReply)) {  // check original text for [END] signal
    callLog(session.callSid, '[call] ending call — farewell detected');
    session.state = 'ending';
    pushToBrowser(session, { event: 'call-ended' });
    sendFollowUpEmailLegacy(session);
    hangupCall(session);
    return;
  }

  if (pressMatch) {
    callLog(session.callSid, '[dtmf] IVR detected — pressing', pressMatch[1]);
    session.state = 'listening';
    await sendDTMF(session, pressMatch[1]);
    // Twilio will reconnect the stream — handleTwilio start event will resume the session
    return;
  }

  enterListening(session);
}

function enterListening(session) {
  session.state = 'listening';
  session.pendingTranscript = null;
  pushToBrowser(session, { event: 'ai-done' });
}

function prepareForSpeech(text) {
  return text.trim()
    .replace(/\[END\]/gi, '')
    .replace(/\[PRESS:[0-9#*]\]/gi, '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/([^.!?])$/, '$1.')
    .trim();
}

// Stream OpenAI tokens directly into ElevenLabs WebSocket — fast response + consistent voice
async function streamOpenAIAndSpeak(session, messages, callerTurn) {
  try {
    const aiCtrl = new AbortController();
    const aiTimer = setTimeout(() => aiCtrl.abort(), 8000);
    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 80, temperature: 0.75, stream: true }),
      signal: aiCtrl.signal
    });
    clearTimeout(aiTimer);
    if (!aiResp.ok) return null;
    if (session.turnId !== callerTurn) { aiResp.body.cancel().catch(() => {}); return null; }

    const elUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream-input` +
      `?model_id=${ELEVENLABS_VOICE_SETTINGS.model_id}&output_format=pcm_16000&optimize_streaming_latency=4` +
      `&xi_api_key=${ELEVENLABS_KEY}`;
    const elWs = new WebSocket(elUrl, { headers: { 'xi-api-key': ELEVENLABS_KEY } });

    let fullText = '';
    let myGen = null;
    let audioStarted = false;
    let audioBuf = Buffer.alloc(0);
    let elReady = false;
    let textQueue = '';
    let resolved = false;
    const CHUNK = 640; // pcm_16000: 640 bytes = 320 samples = 20ms, downsampled to 160 bytes mulaw
    const isStale = () => session.turnId !== callerTurn || (myGen !== null && session.speakGen !== myGen);

    const result = await new Promise((resolve) => {
      const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

      elWs.on('open', () => {
        elReady = true;
        elWs.send(JSON.stringify({
          text: ' ',
          voice_settings: ELEVENLABS_VOICE_SETTINGS.voice_settings,
          generation_config: { chunk_length_schedule: [15, 35, 70] },
        }));
        if (textQueue) { elWs.send(JSON.stringify({ text: textQueue })); textQueue = ''; }
      });

      elWs.on('message', (raw) => {
        if (isStale()) { elWs.close(); done(fullText.trim() || null); return; }
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.audio) {
            if (!audioStarted) {
              audioStarted = true;
              if (session.twilioWs?.readyState === WebSocket.OPEN)
                session.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
              session.state = 'speaking';
              session.speakStartTime = Date.now();
              myGen = ++session.speakGen;
            }
            audioBuf = Buffer.concat([audioBuf, Buffer.from(msg.audio, 'base64')]);
            while (!isStale() && audioBuf.length >= CHUNK && session.twilioWs?.readyState === WebSocket.OPEN) {
              const pcm = new Int16Array(audioBuf.buffer, audioBuf.byteOffset, CHUNK / 2);
              session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: pcm16ToMulaw(pcm).toString('base64') } }));
              audioBuf = audioBuf.slice(CHUNK);
            }
          }
          if (msg.isFinal) {
            if (!isStale() && audioBuf.length >= 2 && session.twilioWs?.readyState === WebSocket.OPEN) {
              const pcm = new Int16Array(audioBuf.buffer, audioBuf.byteOffset, Math.floor(audioBuf.length / 2));
              session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: pcm16ToMulaw(pcm).toString('base64') } }));
            }
            done(fullText.trim() || null);
          }
        } catch (e) { callLog(session.callSid, '[el-ws] msg error:', e.message); }
      });

      elWs.on('error', (e) => {
        callLog(session.callSid, '[el-ws] error:', e.message);
        if (!audioStarted && fullText.trim() && session.turnId === callerTurn) {
          callLog(session.callSid, '[el-ws] falling back to HTTP TTS');
          session.state = 'speaking'; session.speakStartTime = Date.now();
          myGen = ++session.speakGen; audioStarted = true;
          streamTTS(session, fullText.trim(), myGen).then(() => done(fullText.trim())).catch(() => done(null));
        } else { done(null); }
      });
      elWs.on('unexpected-response', (req, res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => callLog(session.callSid, '[el-ws] unexpected-response:', res.statusCode, body.slice(0, 300)));
      });
      elWs.on('close', (code, reason) => {
        if (code !== 1000) {
          callLog(session.callSid, '[el-ws] closed code:', code, 'reason:', (reason?.toString() || '(none)').slice(0, 300));
          if (!audioStarted && fullText.trim() && session.turnId === callerTurn) {
            callLog(session.callSid, '[el-ws] falling back to HTTP TTS');
            session.state = 'speaking'; session.speakStartTime = Date.now();
            myGen = ++session.speakGen; audioStarted = true;
            streamTTS(session, fullText.trim(), myGen).then(() => done(fullText.trim())).catch(() => done(null));
            return;
          }
        }
        done(fullText.trim() || null);
      });

      // Pipe OpenAI tokens into ElevenLabs WS as they arrive
      (async () => {
        const reader = aiResp.body.getReader();
        const decoder = new TextDecoder();
        let parseBuf = '';
        try {
          while (true) {
            if (isStale()) { reader.cancel().catch(() => {}); break; }
            const { done: d, value } = await reader.read();
            if (d) break;
            parseBuf += decoder.decode(value, { stream: true });
            const lines = parseBuf.split('\n');
            parseBuf = lines.pop();
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6);
              if (data === '[DONE]') break;
              try {
                const token = JSON.parse(data).choices?.[0]?.delta?.content;
                if (token) {
                  fullText += token;
                  if (elReady && elWs.readyState === WebSocket.OPEN)
                    elWs.send(JSON.stringify({ text: token }));
                  else
                    textQueue += token;
                }
              } catch {}
            }
          }
        } catch (e) { callLog(session.callSid, '[ai] pipe error:', e.message); }
        if (elWs.readyState === WebSocket.OPEN) elWs.send(JSON.stringify({ text: '' }));
      })();
    });

    if (!result || !audioStarted || myGen === null) return result;

    pushToBrowser(session, { event: 'ai-speaking', text: result });
    if (session.speakGen === myGen && session.turnId === callerTurn) {
      const markName = 'tts-' + Date.now();
      if (sendMark(session, markName)) await awaitMark(session, markName, 20000);
    }
    return result;
  } catch (e) {
    callLog(session.callSid, '[ai] stream error:', e.message);
    return null;
  }
}

async function callOpenAI(messages) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 50, temperature: 0.75 }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { console.error('[openai] error:', e.message); return null; }
}

const ELEVENLABS_VOICE_SETTINGS = {
  model_id: 'eleven_turbo_v2_5',
  voice_settings: {
    stability: 0.42,
    similarity_boost: 0.80,
    style: 0.16,
    use_speaker_boost: true,
  },
};


function sendMark(session, name) {
  if (session.twilioWs?.readyState !== WebSocket.OPEN) return false;
  session.twilioWs.send(JSON.stringify({ event: 'mark', streamSid: session.streamSid, mark: { name } }));
  return true;
}

function awaitMark(session, name, ms = 10000) {
  return new Promise(resolve => {
    session.markResolvers[name] = resolve;
    setTimeout(() => { delete session.markResolvers[name]; resolve(); }, ms);
  });
}

async function speakToTwilio(session, text) {
  if (session.twilioWs?.readyState !== WebSocket.OPEN) return;
  session.state = 'speaking';
  session.speakStartTime = Date.now();
  const myGen = ++session.speakGen;
  callLog(session.callSid, '[tts] speaking:', text.slice(0, 60));
  pushToBrowser(session, { event: 'ai-speaking', text });
  try {
    await streamTTS(session, text, myGen);
  } catch (e) { callLog(session.callSid, '[tts] error:', e.message); }
  if (session.speakGen !== myGen) return; // barged in — don't advance state
  const markName = 'tts-' + Date.now();
  if (sendMark(session, markName)) await awaitMark(session, markName, 4000);
  if (session.speakGen === myGen) enterListening(session);
}

async function streamTTS(session, text, gen) {
  if (!ELEVENLABS_KEY) { console.log('[tts] no ElevenLabs key — skipping'); return; }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream?output_format=ulaw_8000&optimize_streaming_latency=4`, {
      method: 'POST', headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prepareForSpeech(text), ...ELEVENLABS_VOICE_SETTINGS }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (resp.ok) {
      await pipeToTwilio(session, resp, 'ulaw8k', gen);
      return;
    }
    const errBody = await resp.text().catch(() => '');
    console.log(`[elevenlabs] error ${resp.status}: ${errBody.slice(0, 200)}`);
  } catch (e) {
    console.log('[elevenlabs] request failed:', e.message);
  }
}

async function pipeToTwilio(session, resp, type, gen) {
  const reader = resp.body.getReader();
  let buffer = Buffer.alloc(0);
  const isStale = () => gen !== undefined && session.speakGen !== gen;
  const readWithTimeout = () => Promise.race([
    reader.read(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('read timeout')), 8000))
  ]);

  // ulaw_8000 from ElevenLabs is already what Twilio needs — pass straight through
  if (type === 'ulaw8k') {
    const CHUNK = 160; // 20ms at 8kHz
    try {
      while (true) {
        if (isStale()) break;
        const { done, value } = await readWithTimeout();
        if (done) break;
        if (!value?.length) continue;
        if (isStale() || session.twilioWs?.readyState !== WebSocket.OPEN) break;
        buffer = Buffer.concat([buffer, Buffer.from(value)]);
        while (buffer.length >= CHUNK) {
          session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: buffer.slice(0, CHUNK).toString('base64') } }));
          buffer = buffer.slice(CHUNK);
        }
      }
      if (!isStale() && buffer.length > 0 && session.twilioWs?.readyState === WebSocket.OPEN) {
        session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: buffer.toString('base64') } }));
      }
    } finally { reader.cancel().catch(() => {}); }
    return;
  }

  // PCM16 → mulaw; 640 bytes PCM16 at 16kHz → 160 bytes mulaw at 8kHz (20ms chunk)
  const chunkBytes = type === 'pcm24k' ? 960 : 640;
  const samplesPerChunk = chunkBytes / 2;
  const encoder = type === 'pcm24k' ? pcm24ToMulaw : pcm16ToMulaw;
  try {
    while (true) {
      if (isStale()) break;
      const { done, value } = await readWithTimeout();
      if (done) break;
      if (!value?.length) continue;
      if (isStale() || session.twilioWs?.readyState !== WebSocket.OPEN) break;
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
      while (buffer.length >= chunkBytes) {
        const pcm = new Int16Array(buffer.buffer, buffer.byteOffset, samplesPerChunk);
        session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: encoder(pcm).toString('base64') } }));
        buffer = buffer.slice(chunkBytes);
      }
    }
    if (!isStale() && buffer.length >= 2 && session.twilioWs?.readyState === WebSocket.OPEN) {
      const pcm = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
      session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: encoder(pcm).toString('base64') } }));
    }
  } finally { reader.cancel().catch(() => {}); }
}


function pcm16ToMulaw(samples) {
  const BIAS = 0x84, CLIP = 32635;
  const out = Buffer.allocUnsafe(Math.floor(samples.length / 2));
  for (let i = 0; i < out.length; i++) {
    let s = samples[i * 2];
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exp = 7, mask = 0x4000;
    while (exp > 0 && (s & mask) === 0) { exp--; mask >>= 1; }
    const mantissa = (s >> (exp + 3)) & 0x0F;
    out[i] = ~(sign | (exp << 4) | mantissa) & 0xFF;
  }
  return out;
}


function pcm24ToMulaw(samples) {
  const BIAS = 0x84, CLIP = 32635;
  const out = Buffer.allocUnsafe(Math.floor(samples.length / 3));
  for (let i = 0; i < out.length; i++) {
    let s = Math.round((samples[i * 3] + (samples[i * 3 + 1] || 0) + (samples[i * 3 + 2] || 0)) / 3);
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exp = 7, mask = 0x4000;
    while (exp > 0 && (s & mask) === 0) { exp--; mask >>= 1; }
    const mantissa = (s >> (exp + 3)) & 0x0F;
    out[i] = ~(sign | (exp << 4) | mantissa) & 0xFF;
  }
  return out;
}

function pushToBrowser(session, data) {
  if (session.browserWs?.readyState === WebSocket.OPEN) session.browserWs.send(JSON.stringify(data));
}

function cleanup(session) { try { session.dgWs?.close(); } catch {} }

// ── OPENAI REALTIME ──────────────────────────────────────────────
function handleTwilioRealtime(ws) {
  let n = '', r = '', c = '', e = '', s = '';
  let streamSid     = null;
  let callSid       = null;
  let openAiWs      = null;
  let sessionReady  = false;
  let pendingAudio  = [];
  let greeted       = false;
  let fallbackTimer = null;
  let startReceived = false;

  let capturedEmail = null; // set after 'start' event when e= param arrives
  let emailSent     = false;
  let responseText  = '';

  function buildInstructions() {
    const parts = [
      'You are Brandy — a sharp, confident Southern saleswoman on a live outbound call. You close deals.',
      'ONE sentence per response, then a short question. Always end with a question — never leave a statement hanging.',
      'Always steering toward the close — handle objections, build urgency, ask for the business.',
      'Use assumptive language: "When we get you set up..." not "If you decide to..."',
      'Create mild urgency — mention limited availability or others in their area moving on it.',
      'On interest: ask a trial close — "Does that sound like something that would work for you?"',
      'On hesitation: dig — "What\'s the main thing holding you back?"',
      'On price: hold firm, reframe ROI. First no = reframe. Second no = one small concession. Third no = offer to email, warm goodbye.',
      'Never apologize for the price. "Yeah, it\'s an investment, and it pays for itself fast."',
      'NEVER invent product names, prices, details, addresses, phone numbers, or account info you were not given. You have no customer files or records on hand — if asked "what do you have on file" or similar, say you\'ll need them to confirm it and redirect back to the conversation.',
      'Start replies: "Yeah", "Look", "So", "Right", "Oh", "Honestly", "I mean".',
      'Banned: "Absolutely", "Certainly", "Of course", "I understand", "Great", "Definitely", "No problem", "Sounds good", "I appreciate that", "I get that", "I hear you", "That makes sense".',
      'ENDING THE CALL: When the conversation is over, say a warm goodbye, then end your response with the exact phrase "take care now" — lowercase, as your final words.',
    ];
    if (c) parts.push(`You are calling on behalf of ${c}.`);
    if (r) parts.push(`Background context (guide conversation, don't recite): ${r}.`);
    if (n) parts.push(`You are speaking with ${n}.`);
    parts.push('NEGOTIATION: Start at the given price. Never volunteer a lower number — only concede after explicit pushback, one small step at a time.');
    return parts.join(' ');
  }

  function buildSessionUpdate() {
    return {
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: buildInstructions(),
        voice: 'coral',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.7,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
          create_response: false,
        },
      }
    };
  }

  function sendFollowUpEmail() {
    console.log('[email] sendFollowUpEmail called — capturedEmail:', capturedEmail, '| emailSent:', emailSent);
    if (emailSent) { console.log('[email] skipped — already sent'); return; }
    if (!capturedEmail) { console.log('[email] skipped — no capturedEmail'); return; }
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) { console.log('[email] skipped — RESEND_API_KEY not set'); return; }
    emailSent = true;
    const firstName = (n || 'there').trim().split(/\s+/)[0];
    const company   = c || 'PayPilot AI';
    const reason    = r ? summarizeReasonForEmail(r) : 'our conversation today';
    const fromEmail = process.env.FROM_EMAIL || 'info@paypilotai.live';
    const fromName  = process.env.FROM_NAME  || 'PayPilot AI';
    console.log('[email] sending to:', capturedEmail, '| from:', fromEmail, '| company:', company);
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: [capturedEmail],
        reply_to: s || fromEmail,
        subject: `Following up from our call — ${company}`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;"><h2 style="color:#0f172a;">Hi ${firstName},</h2><p style="color:#374151;font-size:16px;line-height:1.7;">Thanks so much for chatting today! As promised, I'm following up about ${reason}. If you have any questions or want to move forward, just reply to this email — I'd love to help.</p><p style="color:#64748b;font-size:14px;margin-top:28px;">Talk soon,<br/>Brandy<br/>${company}</p></div>`,
      }),
    }).then(async resp => {
      const body = await resp.text();
      console.log('[email] Resend response:', resp.status, body.slice(0, 200));
    }).catch(err => console.error('[email] fetch error:', err.message));
  }

  function triggerGreeting() {
    if (greeted || openAiWs?.readyState !== WebSocket.OPEN) return;
    greeted = true;
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    let msg = 'Give a brief, warm Southern greeting. Say your name is Brandy';
    if (c) msg += `, calling from ${c}`;
    msg += '.';
    if (n) msg += ` Greet ${n} directly by name — no "is ${n} available", you are already speaking with them.`;
    else   msg += ' Ask who you\'re speaking with.';
    msg += ' One sentence, natural and warm.';
    openAiWs.send(JSON.stringify({
      type: 'response.create',
      response: { modalities: ['audio', 'text'], instructions: msg }
    }));
  }

  function startFallbackTimer() {
    if (fallbackTimer || greeted) return;
    fallbackTimer = setTimeout(triggerGreeting, 2000);
  }

  function sendAudio(payload) {
    if (streamSid && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    } else {
      pendingAudio.push(payload);
    }
  }

  function doHangup() {
    if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && callSid) {
      const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'Status=completed'
      }).catch(() => {});
    }
    setTimeout(() => { try { ws.close(); } catch {} }, 2000);
  }

  function connectOpenAI() {
    openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
    );

    openAiWs.on('open', () => {
      console.log('[realtime] OpenAI ws open');
      if (startReceived) openAiWs.send(JSON.stringify(buildSessionUpdate()));
    });

    openAiWs.on('message', raw => {
      try {
        const ev = JSON.parse(raw);

        if (ev.type === 'session.updated' && !sessionReady) {
          sessionReady = true;
          console.log('[realtime] session ready');
          if (streamSid) {
            // Flush any audio that arrived before session was ready
            for (const p of pendingAudio) ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: p } }));
            pendingAudio = [];
            startFallbackTimer();
          }
        }

        if (ev.type === 'response.audio.delta' && ev.delta) {
          sendAudio(ev.delta);
        }

        if (ev.type === 'response.text.delta' && ev.delta) {
          responseText += ev.delta;
        }

        if (ev.type === 'response.done') {
          const text = responseText.toLowerCase();
          responseText = '';
          console.log('[realtime] response done, checking for farewell');
          if (text.includes('take care now')) {
            console.log('[realtime] farewell detected — hanging up');
            sendFollowUpEmail();
            setTimeout(doHangup, 2000);
          }
        }

        // Buffer committed — trigger response immediately (faster than waiting for speech_stopped)
        if (ev.type === 'input_audio_buffer.committed') {
          openAiWs.send(JSON.stringify({ type: 'response.create' }));
        }

        // Barge-in: user started speaking — cancel in-flight response + clear Twilio audio buffer
        // Only act if we are NOT already mid-response (avoid self-triggering on Brandy's own audio)
        if (ev.type === 'input_audio_buffer.speech_started') {
          const isResponding = ev.item_id != null;
          if (!isResponding) {
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
          }
          if (streamSid && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: 'clear', streamSid }));
          }
        }

        if (ev.type === 'error') {
          console.error('[realtime] OpenAI error:', JSON.stringify(ev.error));
        }
      } catch (err) { console.error('[realtime] message error:', err.message); }
    });

    openAiWs.on('close', (code, reason) => {
      console.log('[realtime] OpenAI disconnected', code, reason?.toString());
      if (ws.readyState === WebSocket.OPEN) ws.close();
    });
    openAiWs.on('error', e => console.error('[realtime] OpenAI ws error:', e.message));
  }

  connectOpenAI();

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        callSid   = msg.start.callSid;
        startReceived = true;
        const cp = msg.start?.customParameters || {};
        n = cp.n || ''; r = cp.r || ''; c = cp.c || ''; e = cp.e || ''; s = cp.s || '';
        if (e && !capturedEmail) capturedEmail = e; // email from call setup params
        console.log('[realtime] start — name:', n || '(none)', '| email:', capturedEmail || '(none)');

        if (openAiWs?.readyState === WebSocket.OPEN) {
          openAiWs.send(JSON.stringify(buildSessionUpdate()));
        }
        if (sessionReady) {
          for (const p of pendingAudio) ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: p } }));
          pendingAudio = [];
          startFallbackTimer();
        }
      }

      if (msg.event === 'media' && openAiWs?.readyState === WebSocket.OPEN && sessionReady) {
        openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
      }

      if (msg.event === 'stop') openAiWs?.close();
    } catch (err) { console.error('[realtime] ws message error:', err.message); }
  });

  ws.on('close', () => { if (fallbackTimer) clearTimeout(fallbackTimer); sendFollowUpEmail(); openAiWs?.close(); });
  ws.on('error', e => console.error('[realtime] Twilio ws error:', e.message));
}

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection — keeping process alive:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException — keeping process alive:', err.message, err.stack);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PayPilot AI server on :${PORT}`);
});
