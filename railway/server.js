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
const ELEVENLABS_VOICE  = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  'You are Brandy, a friendly and natural-sounding woman making an outbound call. Talk like a real person — casual, warm, never robotic or scripted. ' +
  'You just asked if you reached the right person. ' +
  'Treat ANY of these as a YES: "yes", "sure", "yeah", "yep", "speaking", "this is", "that\'s me", "uh huh", or anything that does not clearly mean wrong number. ' +
  'If YES: introduce yourself and the company, briefly say why you\'re calling, ask if they have a minute. Keep it short and natural — one or two sentences max. ' +
  'Only write [END] if they clearly say wrong number, not available, or ask you to stop calling. ' +
  'After the intro: keep each reply to one short natural sentence. React directly to what they just said. Use contractions. Sound like you\'re having a real conversation. ' +
  'On pushback: try a different angle. Second no: offer to follow up by email. Third no: friendly goodbye then [END]. ' +
  'If they agree or want to move forward: close warmly, mention a follow-up email, then [END]. ' +
  'Never say: "I understand", "Absolutely", "Certainly", "Of course", "Great", "Definitely", "I appreciate that". No filler phrases.';

function shouldEndCall(text) {
  return text.toLowerCase().includes('[end]');
}
function buildSystemPrompt(session) {
  const base = session.prompt || SYSTEM_PROMPT;
  const parts = [base];
  if (session.company) parts.push(`You are calling on behalf of ${session.company}.`);
  if (session.reason)  parts.push(`Background context for this call (use this to guide the conversation, don't recite it): ${session.reason}.`);
  if (session.name)    parts.push(`You are speaking with ${session.name}.`);
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
  const wsUrl = `wss://${host}/twilio`;
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
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream?output_format=pcm_24000`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello, this is a test.', ...ELEVENLABS_VOICE_SETTINGS })
    });
    results.elevenlabs = r.ok ? 'OK (stream)' : 'ERROR: ' + await r.text();
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
      session = { callSid, streamSid, twilioWs: ws, browserWs: null, dgWs: null, markResolvers: {}, speakGen: 0, greetingTimer: null, state: 'greeting', history: [], prompt: null, name: n, company: c, reason: r, capturedEmail: e || null, senderEmail: s || null, docuSignSent: false };
      sessions.set(callSid, session);
      dgAudioLogged = false;
      callLog(callSid, '[call] started | name:', n || '(none)', '| company:', c || '(none)');
      connectDeepgram(session);
      setTimeout(() => sendGreeting(session), 1500);
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
    '&model=nova-2&punctuate=true&smart_format=true' +
    '&interim_results=false&endpointing=500';
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
      const transcript = result?.channel?.alternatives?.[0]?.transcript?.trim();
      if (!transcript || !result.is_final) return;
      const words = transcript.split(/\s+/).filter(Boolean);
      const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|hm+|huh|mhm|ah+|ow+|eh+|er+|ugh+|ooh+|aah+|oop+|ew+|the|a|an|and|or|but|so|like|just|i|it|is|was|be|to|of|in|that|he|she|they|we)\s*[.?!,]?$/i;
      const TWO_WORD_NOISE = /^(uh (huh|hm)|mm hmm|the the|and and|I I)\s*[.?!]?$/i;
      if (words.length < 1 || NOISE_ONLY.test(transcript) || (words.length === 2 && TWO_WORD_NOISE.test(transcript))) {
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
        callLog(session.callSid, '[email] captured:', rawEmail);
        pushToBrowser(session, { event: 'email-captured', email: rawEmail });
      }

      if (session.state === 'processing') { return; }
      if (session.state !== 'listening') {
        callLog(session.callSid, '[dg] dropped (state=' + session.state + '):', transcript);
        return;
      }
      if (Date.now() - (session.listeningAt || 0) < 1500) {
        callLog(session.callSid, '[dg] cooldown drop:', transcript);
        return;
      }
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

function buildGreeting(name, company) {
  if (name) {
    const GREETINGS = [
      `Hi, is this ${name}?`,
      `Hey, may I speak with ${name}?`,
      `Hi there — is ${name} available?`,
    ];
    return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  }
  const c = company || 'us';
  return `Hi there! This is Brandy calling from ${c}. Who am I speaking with?`;
}

async function sendGreeting(session) {
  const greeting = buildGreeting(session.name, session.company);
  session.history.push({ role: 'assistant', content: greeting });
  pushToBrowser(session, { event: 'ai-response', text: greeting });
  await speakToTwilio(session, greeting);
  session.state = 'listening';
}

const FILLER_PHRASES = [
  'Oh yeah.', 'Mm-hmm.', 'Right, right.', 'Well now...', 'Yeah, I hear you.', 'Oh, for sure.'
];
function pickFiller() { return FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)]; }

async function speakFiller(session, text) {
  if (session.twilioWs?.readyState !== WebSocket.OPEN) return;
  try { await streamTTS(session, text); } catch (_) {}
}

async function generateAndSpeak(session) {
  callLog(session.callSid, '[ai] generating response (streaming)...');
  const messages = [{ role: 'system', content: buildSystemPrompt(session) }, ...session.history.slice(-12)];

  const fullReply = await streamOpenAIAndSpeak(session, messages);
  if (!fullReply) { enterListening(session); return; }

  callLog(session.callSid, '[ai] reply:', fullReply.slice(0, 80));
  session.history.push({ role: 'assistant', content: fullReply });
  pushToBrowser(session, { event: 'ai-response', text: fullReply });

  // Auto-send DocuSign if we just captured an email and haven't sent yet
  if (session.capturedEmail && !session.docuSignSent) {
    session.docuSignSent = true;
    callLog(session.callSid, '[docusign] sending agreement to', session.capturedEmail);
    try {
      await fetch('https://paypilot-ai.vercel.app/api/send-agreement', {
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
      });
      callLog(session.callSid, '[docusign] sent successfully');
      pushToBrowser(session, { event: 'docusign-sent', email: session.capturedEmail });
    } catch (e) {
      callLog(session.callSid, '[docusign] send failed:', e.message);
    }
  }

  if (shouldEndCall(fullReply)) {
    callLog(session.callSid, '[call] ending call — farewell detected');
    pushToBrowser(session, { event: 'call-ended' });
    setTimeout(() => { try { session.twilioWs?.close(); } catch {} }, 500);
    return;
  }

  enterListening(session);
}

function enterListening(session) {
  session.listeningAt = Date.now();
  session.state = 'listening';
  session.pendingTranscript = null;
  pushToBrowser(session, { event: 'ai-done' });
}

function prepareForSpeech(text) {
  return text.trim()
    .replace(/\[END\]/gi, '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/([^.!?])$/, '$1.')
    .trim();
}

// Collect full OpenAI reply via streaming, then speak as one continuous TTS call
async function streamOpenAIAndSpeak(session, messages) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 60, temperature: 0.75, stream: true }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!resp.ok) return null;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let fullText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') break;
        try {
          const token = JSON.parse(data).choices?.[0]?.delta?.content;
          if (token) fullText += token;
        } catch {}
      }
    }
    fullText = fullText.trim();
    if (!fullText) return null;

    if (session.twilioWs?.readyState === WebSocket.OPEN) {
      session.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    session.state = 'speaking';
    const myGen = ++session.speakGen;
    pushToBrowser(session, { event: 'ai-speaking', text: fullText });
    await streamTTS(session, fullText, myGen);

    if (session.speakGen === myGen) {
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
      body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 60, temperature: 0.75 }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { console.error('[openai] error:', e.message); return null; }
}

const ELEVENLABS_VOICE_SETTINGS = {
  model_id: 'eleven_turbo_v2_5',
  voice_settings: { stability: 0.30, similarity_boost: 0.80, style: 0.40, use_speaker_boost: true, speed: 0.90 }
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
  if (session.speakGen !== myGen) return;  // barged in — don't advance state
  const markName = 'tts-' + Date.now();
  if (sendMark(session, markName)) await awaitMark(session, markName, 4000);
  if (session.speakGen === myGen) enterListening(session);
}

async function streamTTS(session, text, gen) {
  // Try ElevenLabs — skip entirely if it failed before on this server instance
  if (ELEVENLABS_KEY && !isElevenlabsBlocked()) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream?output_format=pcm_24000`, {
        method: 'POST', headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: prepareForSpeech(text), ...ELEVENLABS_VOICE_SETTINGS }),
        signal: ctrl.signal
      });
      clearTimeout(t);
      const ct = resp.headers.get('content-type') || '';
      console.log(`[elevenlabs] status=${resp.status} content-type=${ct}`);
      if (resp.ok) {
        elevenlabsBlocked = false;
        await pipeToTwilio(session, resp, 'pcm24k', gen);
        return;
      }
      const errBody = await resp.text().catch(() => '');
      console.log(`[elevenlabs] error ${resp.status}: ${errBody.slice(0, 200)}`);
      elevenlabsBlocked = true;
      elevenlabsBlockedAt = Date.now();
      console.log('[elevenlabs] blocked — falling back to OpenAI TTS, will retry in 5m');
    } catch (_) {
      elevenlabsBlocked = true;
      elevenlabsBlockedAt = Date.now();
      console.log('[elevenlabs] timed out — falling back to OpenAI TTS, will retry in 5m');
    }
  }

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
  // Params arrive via Twilio customParameters in the 'start' event — much more reliable
  // than URL query params (avoids XML &amp; encoding edge cases).
  let n = '';
  let r = '';
  let c = '';

  let streamSid      = null;
  let openAiWs       = null;
  let sessionReady   = false;
  let pendingAudio   = [];
  let greeted        = false;
  let fallbackTimer  = null;
  let startReceived  = false;

  function buildSessionUpdate() {
    const company = c || '';
    const name    = n || '';
    const reason  = r || '';
    const instructions =
      `ALWAYS speak English only. You are Brandy, a warm Southern woman on an outbound sales call` +
      (company ? ` for ${company}` : '') + `.\n` +
      (name   ? `You are calling to speak with ${name}.\n` : '') +
      (reason ? `Purpose of the call: ${reason}.\n` : '') +
      `\nYou are a real salesperson — warm, genuine, and always moving the conversation toward the close.\n` +
      `Build rapport quickly, but never lose sight of why you called. You are ALWAYS SELLING.\n\n` +
      `STYLE:\n` +
      `- Speak naturally — unhurried, like you have all the time in the world.\n` +
      `- Match their energy. Guarded? Ease them in. Chatty? Match that warmth.\n` +
      `- Really listen and react to what they say specifically.\n` +
      `- Use natural fillers: "mm", "yeah", "oh", "well" — only when they feel real.\n` +
      `- ONE thing at a time, then stop and let them talk.\n` +
      `- Handle objections by finding common ground, then redirecting to value.\n` +
      `- Always be guiding toward the next step: interest, commitment, or close.\n\n` +
      `BANNED: "I understand", "Absolutely", "Certainly", "Of course", "Great question", "Definitely".`;
    return {
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions,
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 200,
              silence_duration_ms: 500,
              create_response: true,
              interrupt_response: true
            }
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: 'coral'
          }
        }
      }
    };
  }

  function startFallbackTimer() {
    if (fallbackTimer || greeted) return;
    fallbackTimer = setTimeout(triggerGreeting, 3000);
  }

  function triggerGreeting() {
    if (greeted || openAiWs?.readyState !== WebSocket.OPEN) return;
    greeted = true;
    if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null; }
    const company = c || '';
    const name    = n || '';
    let greetInstruction = 'In English only, give a warm Southern greeting. Say your name is Brandy';
    if (company) greetInstruction += `, you are calling from ${company}`;
    greetInstruction += ', and that this call may be recorded for quality purposes.';
    if (name)   greetInstruction += ` Ask if ${name} is available to speak.`;
    else        greetInstruction += ' Ask who you are speaking with.';
    openAiWs.send(JSON.stringify({
      type: 'response.create',
      response: { output_modalities: ['audio'], instructions: greetInstruction }
    }));
  }

  function sendAudio(payload) {
    if (streamSid) {
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    } else {
      pendingAudio.push(payload);
    }
  }

  function connectOpenAI() {
    openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    openAiWs.on('open', () => {
      console.log('[realtime] OpenAI ws open');
      try {
        if (startReceived) {
          openAiWs.send(JSON.stringify(buildSessionUpdate()));
        }
      } catch (e) { console.error('[realtime] open handler error:', e.message); }
    });

    openAiWs.on('message', raw => {
      try {
        const ev = JSON.parse(raw);
        if (ev.type !== 'session.created') console.log('[realtime] event:', ev.type);

        if (ev.type === 'session.updated' && !sessionReady) {
          sessionReady = true;
          console.log('[realtime] session ready — name:', n || '(none)', 'company:', c || '(none)');
          if (streamSid) startFallbackTimer();
        }

        if (ev.type === 'input_audio_buffer.speech_stopped') {
          if (!greeted) {
            triggerGreeting();
          } else {
            openAiWs.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }));
          }
        }

        if (ev.type === 'response.audio.delta' && ev.delta) {
          sendAudio(ev.delta);
        }

        if (ev.type === 'input_audio_buffer.speech_started' && streamSid) {
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
        }

        if (ev.type === 'error') {
          console.error('[realtime] OpenAI error:', JSON.stringify(ev.error));
        }
      } catch {}
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
        startReceived = true;

        // Read params from Twilio customParameters — guaranteed clean strings
        const cp = msg.start?.customParameters || {};
        n = cp.n || '';
        r = cp.r || '';
        c = cp.c || '';
        console.log('[realtime] start — name:', n || '(none)', '| company:', c || '(none)', '| reason:', r || '(none)');

        // Flush buffered audio
        for (const payload of pendingAudio) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
        }
        pendingAudio = [];

        // Send session.update now that we have the correct params
        if (openAiWs?.readyState === WebSocket.OPEN) {
          openAiWs.send(JSON.stringify(buildSessionUpdate()));
        }
        // If OpenAI ws not open yet, it'll send in the 'open' handler above
      }

      if (msg.event === 'media' && openAiWs?.readyState === WebSocket.OPEN && sessionReady) {
        openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
      }

      if (msg.event === 'stop') openAiWs?.close();
    } catch {}
  });

  ws.on('close', () => { if (fallbackTimer) clearTimeout(fallbackTimer); openAiWs?.close(); });
  ws.on('error', e => console.error('[realtime] Twilio ws error:', e.message));
}

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection — keeping process alive:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException — keeping process alive:', err.message, err.stack);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PayPilot AI server on :${PORT}`));
