const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

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
const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  'You are Brandy — a sharp, confident Southern saleswoman on a live outbound call. You close deals. ' +
  'ONE sentence per response, max two. Conversational, never scripted. ' +
  'You are always steering toward the close — every response either handles an objection, builds urgency, or asks for the business. ' +
  'Use assumptive language: "When we get you set up..." not "If you decide to..." ' +
  'Create mild urgency naturally — mention limited availability or that others in their area are moving on it. ' +
  'On interest: ask a trial close — "Does that sound like something that would work for you?" ' +
  'On hesitation: dig for the real concern — "What\'s the main thing holding you back?" ' +
  'On price objection: hold firm, reframe the value or ROI. Do NOT drop the price. First no = reframe. Second no = one small concession. Third no = offer to email, warm goodbye [END]. ' +
  'Never apologize for the price. Never say "I know it\'s a lot." Own it — "Yeah, it\'s an investment, and it pays for itself fast." ' +
  'NEVER invent product names, prices, or details you weren\'t given. Only sell what you know. ' +
  'Email given: read it back, confirm you\'ll send something over, keep moving toward the close. ' +
  'To end: warm, confident close — "Talk soon!" or "Looking forward to it!" — then [END]. Never [END] without a goodbye. ' +
  'Start replies with: "Yeah", "Look", "So", "Right", "Oh", "Honestly", "I mean" — real talk. ' +
  'Banned words: "Absolutely", "Certainly", "Of course", "I understand", "Great", "Definitely", "No problem", "Sounds good", "I appreciate that", "I get that", "I totally get that", "I hear you", "I can understand", "That makes sense".';

function shouldEndCall(text) {
  return text.toLowerCase().includes('[end]');
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
function buildSystemPrompt(session) {
  const base = session.prompt || SYSTEM_PROMPT;
  const parts = [base];
  if (session.company) parts.push(`You are calling on behalf of ${session.company}.`);
  if (session.reason)  parts.push(`Background context for this call (use this to guide the conversation, don't recite it): ${session.reason}.`);
  if (session.name)    parts.push(`You are speaking with ${session.name}.`);
  parts.push('NEGOTIATION RULES: Always start at the rate or price you were given and hold it. Never volunteer a lower number or your floor — only come down if they explicitly push back. Concede one small step at a time. Do not give away your bottom line.');
  return parts.join(' ');
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

app.all('/twiml-stream', (req, res) => {
  const n = req.query.n || '';
  const r = req.query.r || '';
  const c = req.query.c || '';
  const e = req.query.e || '';
  const s = req.query.s || '';
  const host = process.env.RAILWAY_PUBLIC_DOMAIN ||
               req.headers['x-forwarded-host'] ||
               req.headers.host || '';
  console.log('[twiml-stream] host:', host, 'n:', n, 'r:', r, 'c:', c, 'e:', e ? '(set)' : '(none)', 's:', s ? '(set)' : '(none)', 'method:', req.method);
  const wsUrl = `wss://${host}/twilio-realtime`;
  // Pass params as Twilio <Parameter> elements — reliable, no URL-encoding edge cases
  const paramXml = [
    n ? `<Parameter name="n" value="${xmlEsc(n)}"/>` : '',
    r ? `<Parameter name="r" value="${xmlEsc(r)}"/>` : '',
    c ? `<Parameter name="c" value="${xmlEsc(c)}"/>` : '',
    e ? `<Parameter name="e" value="${xmlEsc(e)}"/>` : '',
    s ? `<Parameter name="s" value="${xmlEsc(s)}"/>` : '',
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
      body: JSON.stringify({ text: 'test', model_id: 'eleven_turbo_v2', output_format: 'pcm_16000' })
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
      session = { callSid, streamSid, twilioWs: ws, browserWs: null, dgWs: null, markResolvers: {}, ttsAbort: null, bargedIn: false, greetingTimer: null, state: 'greeting', speakGen: 0, turnId: 0, history: [], prompt: null, name: n, company: c, reason: r, capturedEmail: e || null, emailFromSpeech: false, senderEmail: s || null, docuSignSent: false };
      sessions.set(callSid, session);
      dgAudioLogged = false;
      callLog(callSid, '[call] started | name:', n || '(none)', '| company:', c || '(none)');
      connectDeepgram(session);
      setTimeout(() => sendGreeting(session), 800);
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
  ws.on('close', () => { if (session) { cleanup(session); sessions.delete(session.callSid); } });
}

function handleBrowser(ws, callSid) {
  if (callSid && sessions.has(callSid)) {
    sessions.get(callSid).browserWs = ws;
    ws.send(JSON.stringify({ event: 'connected', callSid }));
  }
  ws.on('close', () => { if (callSid && sessions.has(callSid)) sessions.get(callSid).browserWs = null; });
}

function connectDeepgram(session) {
  const dgUrl = 'wss://api.deepgram.com/v1/listen' +
    '?encoding=mulaw&sample_rate=8000&channels=1' +
    '&model=nova-2-phonecall&punctuate=true' +
    '&interim_results=false&endpointing=300&vad_events=true';
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
      // Barge-in: cut audio immediately when user starts speaking
      if (result.type === 'SpeechStarted' && session.state === 'speaking' && session.state !== 'ending') {
        callLog(session.callSid, '[barge-in] SpeechStarted — clearing audio');
        ++session.speakGen; // cuts TTS audio immediately
        // do NOT increment turnId here — only a real transcript should invalidate the turn
        if (session.twilioWs?.readyState === WebSocket.OPEN) {
          session.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
        }
        return;
      }

      const transcript = result?.channel?.alternatives?.[0]?.transcript?.trim();
      const confidence = result?.channel?.alternatives?.[0]?.confidence ?? 1;
      if (!transcript || !result.is_final) return;
      if (confidence < 0.80) {
        callLog(session.callSid, '[dg] low confidence (' + confidence.toFixed(2) + '), skipping:', transcript);
        return;
      }
      const words = transcript.split(/\s+/).filter(Boolean);
      // Single-word filler sounds
      const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|hm+|huh|mhm|ah+|oh+|ow+|ha+|eh+|er+|ugh+|ooh+|yep|nope|yeah|nah|ok|okay|hello+|hey+|hi+|bye+|ew+|wow|whoa|right|sure|cool|nice|yep|yup|no|yes|mhm|aha)\s*[.?!]?$/i;
      // Two-word noise combos
      const TWO_WORD_NOISE = /^(uh (huh|oh|yeah|ok|okay|hm)|oh (ok|okay|yeah|wow|right|sure|hmm|really)|mm (hmm|yeah|ok)|yeah (ok|okay|sure|right|hmm|yeah)|oh my|my god|oh god|all right|alright)[.?!]?$/i;
      if (words.length < 1
        || NOISE_ONLY.test(transcript)
        || (words.length === 2 && TWO_WORD_NOISE.test(transcript))
        || (words.length < 3 && /^[^a-zA-Z]*$/.test(transcript))) {
        callLog(session.callSid, '[dg] filtered noise:', transcript);
        return;
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

      if (session.state === 'processing') { return; }
      if (session.state === 'speaking') {
        // Barge-in: user spoke while Brandy is talking — cut her off and respond
        callLog(session.callSid, '[barge-in] cutting Brandy off:', transcript);
        if (session.twilioWs?.readyState === WebSocket.OPEN) {
          session.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
        }
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
  const n = name    ? name    : 'there';
  const c = company ? company : 'us';
  const r = reason  ? ` — I was reaching out about ${reason}` : '';
  const GREETINGS = [
    `Hey ${n}! This is Brandy calling from ${c}${r}. You got a quick second?`,
    `Hi ${n}! Brandy here with ${c}${r}. Is now an okay time?`,
    `Hey ${n}! It's Brandy from ${c}${r}. Am I catching you at an okay time?`,
  ];
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}

async function sendGreeting(session) {
  const greeting = buildGreeting(session.name, session.company, session.reason);
  session.history.push({ role: 'assistant', content: greeting });
  pushToBrowser(session, { event: 'ai-response', text: greeting });
  await speakToTwilio(session, greeting);
  // speakToTwilio already calls enterListening when done — don't overwrite state here
  // or we'll clobber 'speaking'/'processing' if the user barged in during the greeting
}

const FILLER_PHRASES = [
  'Oh yeah.', 'Mm-hmm.', 'Right, right.', 'Well now...', 'Yeah, for sure.'
];
function pickFiller() { return FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)]; }

async function speakFiller(session, text) {
  if (session.twilioWs?.readyState !== WebSocket.OPEN) return;
  try { await streamTTS(session, text); } catch (_) {}
}

const FILLERS = ['Mm-hmm.', 'Yeah.', 'Right.', 'Mm.', 'Oh.'];
let fillerIdx = 0;

// Pre-cache filler audio at startup so they play instantly (no API round-trip)
const fillerCache = new Map(); // text → Buffer of mulaw 8kHz bytes
async function precacheFillers() {
  if (!ELEVENLABS_KEY) return;
  for (const text of FILLERS) {
    try {
      const resp = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream?output_format=ulaw_8000`,
        { method: 'POST', headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, ...ELEVENLABS_VOICE_SETTINGS }) }
      );
      if (resp.ok) {
        fillerCache.set(text, Buffer.from(await resp.arrayBuffer()));
        console.log('[filler] cached:', text);
      }
    } catch (e) { console.log('[filler] cache failed for:', text, e.message); }
  }
}

function playCachedFiller(session, text, gen) {
  const buf = fillerCache.get(text);
  if (!buf || session.twilioWs?.readyState !== WebSocket.OPEN) return;
  const isStale = () => session.speakGen !== gen;
  const CHUNK = 160;
  for (let i = 0; i < buf.length; i += CHUNK) {
    if (isStale()) break;
    session.twilioWs.send(JSON.stringify({
      event: 'media', streamSid: session.streamSid,
      media: { payload: buf.slice(i, Math.min(i + CHUNK, buf.length)).toString('base64') }
    }));
  }
}

async function generateAndSpeak(session) {
  const myTurn = ++session.turnId;
  callLog(session.callSid, '[ai] generating response (turn=' + myTurn + ')...');
  const messages = [{ role: 'system', content: buildSystemPrompt(session) }, ...session.history.slice(-12)];

  // Play a filler immediately so there's no dead air while OpenAI generates
  const fillerGen = ++session.speakGen;
  session.state = 'speaking';
  const filler = FILLERS[fillerIdx++ % FILLERS.length];
  if (fillerCache.has(filler)) {
    playCachedFiller(session, filler, fillerGen);
  } else {
    streamTTS(session, filler, fillerGen).catch(() => {});
  }

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

  const cleanReply = fullReply.replace(/\[END\]/gi, '').trim();
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
    hangupCall(session);
    return;
  }

  enterListening(session);
}

function enterListening(session) {
  session.state = 'listening';
  pushToBrowser(session, { event: 'ai-done' });
  if (session.pendingTranscript) {
    const t = session.pendingTranscript;
    session.pendingTranscript = null;
    callLog(session.callSid, '[dg] flushing buffered transcript:', t);
    session.state = 'processing';
    session.history.push({ role: 'user', content: t });
    generateAndSpeak(session).catch(e => {
      callLog(session.callSid, '[ai] error:', e.message);
      session.state = 'listening';
    });
  }
}

function prepareForSpeech(text) {
  return text.trim()
    .replace(/\[END\]/gi, '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/([^.!?])$/, '$1.')
    .trim();
}

// Stream OpenAI tokens; start TTS as soon as first sentence arrives, chain the rest
async function streamOpenAIAndSpeak(session, messages, callerTurn) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 60, temperature: 0.75, stream: true }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!resp.ok) return null;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let parseBuf = '';
    let fullText = '';
    let sentenceBuf = '';
    let myGen = null;
    let ttsChain = Promise.resolve();

    const flushChunk = (chunk) => {
      chunk = chunk.trim();
      if (!chunk) return;
      // Only bail if a real barge-in (transcript) arrived — turnId will have been incremented
      if (session.turnId !== callerTurn) return;
      if (myGen === null) {
        if (session.twilioWs?.readyState === WebSocket.OPEN) {
          session.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
        }
        session.state = 'speaking';
        myGen = ++session.speakGen;
      }
      const gen = myGen;
      ttsChain = ttsChain.then(() => {
        if (session.turnId !== callerTurn) return;
        return streamTTS(session, chunk, gen);
      });
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
            sentenceBuf += token;
            // Flush on sentence-ending punctuation or natural clause break
            if (/[.!?](\s|$)/.test(token) || /[,;](\s)/.test(token)) {
              flushChunk(sentenceBuf);
              sentenceBuf = '';
            }
          }
        } catch {}
      }
    }
    // Flush any remaining text that didn't end with punctuation
    if (sentenceBuf.trim()) flushChunk(sentenceBuf);

    fullText = fullText.trim();
    if (!fullText || myGen === null) return null;

    pushToBrowser(session, { event: 'ai-speaking', text: fullText });
    await ttsChain;

    if (session.speakGen === myGen && session.turnId === callerTurn) {
      const markName = 'tts-' + Date.now();
      if (sendMark(session, markName)) await awaitMark(session, markName, 4000);
    }

    return fullText;
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
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 90, temperature: 0.75 }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { console.error('[openai] error:', e.message); return null; }
}

const ELEVENLABS_VOICE_SETTINGS = {
  model_id: 'eleven_flash_v2_5',
};

// Reset after 5 minutes so a newly-paid account recovers automatically
let elevenlabsBlocked = false;
let elevenlabsBlockedAt = 0;
function isElevenlabsBlocked() {
  if (!elevenlabsBlocked) return false;
  if (Date.now() - elevenlabsBlockedAt > 5 * 60 * 1000) {
    elevenlabsBlocked = false;
    console.log('[elevenlabs] retry window elapsed — unblocking');
    return false;
  }
  return true;
}

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
  if (ELEVENLABS_KEY && !isElevenlabsBlocked()) {
    // Try ulaw_8000 first (no conversion needed) — fall back to pcm_24000 if plan doesn't support it
    for (const [fmt, fmtType] of [['ulaw_8000', 'ulaw8k'], ['pcm_24000', 'pcm24k']]) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12000);
        const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream?output_format=${fmt}`, {
          method: 'POST', headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: prepareForSpeech(text), ...ELEVENLABS_VOICE_SETTINGS }),
          signal: ctrl.signal
        });
        clearTimeout(t);
        console.log(`[elevenlabs] fmt=${fmt} status=${resp.status}`);
        if (resp.ok) {
          elevenlabsBlocked = false;
          await pipeToTwilio(session, resp, fmtType, gen);
          return;
        }
        const errBody = await resp.text().catch(() => '');
        // 4xx on ulaw_8000 means plan doesn't support it → try pcm_24000 without blocking
        if (fmt === 'ulaw_8000' && resp.status >= 400 && resp.status < 500) {
          console.log(`[elevenlabs] ulaw_8000 not supported (${resp.status}), trying pcm_24000`);
          continue;
        }
        console.log(`[elevenlabs] error ${resp.status}: ${errBody.slice(0, 200)}`);
        elevenlabsBlocked = true;
        elevenlabsBlockedAt = Date.now();
        break;
      } catch (e) {
        if (fmt === 'ulaw_8000') { console.log('[elevenlabs] ulaw_8000 failed, trying pcm_24000'); continue; }
        elevenlabsBlocked = true;
        elevenlabsBlockedAt = Date.now();
        break;
      }
    }
  }

  // OpenAI TTS fallback
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'tts-1', voice: 'shimmer', response_format: 'pcm', speed: 1.0, input: prepareForSpeech(text) }),
    signal: ctrl.signal
  });
  clearTimeout(t);
  if (!resp.ok) throw new Error(`OpenAI TTS ${resp.status}`);
  await pipeToTwilio(session, resp, 'pcm24k', gen);
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

  // PCM → mulaw; 160 mulaw bytes = 20ms at 8kHz (Twilio standard chunk)
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
      'ONE sentence per response. Two max, only if absolutely needed. Short = natural. Long = robotic.',
      'Always steering toward the close — handle objections, build urgency, ask for the business.',
      'Use assumptive language: "When we get you set up..." not "If you decide to..."',
      'Create mild urgency — mention limited availability or others in their area moving on it.',
      'On interest: ask a trial close — "Does that sound like something that would work for you?"',
      'On hesitation: dig — "What\'s the main thing holding you back?"',
      'On price: hold firm, reframe ROI. First no = reframe. Second no = one small concession. Third no = offer to email, warm goodbye.',
      'Never apologize for the price. "Yeah, it\'s an investment, and it pays for itself fast."',
      'NEVER invent product names, prices, or details you weren\'t given.',
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
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 400,
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
    const reason    = r || 'our conversation today';
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
        if (ev.type === 'input_audio_buffer.speech_started') {
          openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
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
  precacheFillers();
});
