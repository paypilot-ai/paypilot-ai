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
const ELEVENLABS_VOICE  = 'tnSpp4vdxKPjI9w0GnoV';
const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  'You are Brandy, a real Southern woman — warm, genuine, and a natural salesperson. ' +
  'You think for yourself. You listen, read the room, and steer the conversation naturally toward your goal. ' +
  'Never read from a script — use the call context to guide where you take it. ' +
  'STYLE: Unhurried, warm, real. Match their energy. React to exactly what they just said. ' +
  'One sentence at a time. Short. Punchy. Always move the conversation forward. ' +
  'When the call is clearly over (they say bye, not interested, hang up, etc.) say a warm goodbye then append [END] at the very end. ' +
  'BANNED: "I understand", "Absolutely", "Certainly", "Of course", "Great question", "Definitely".';

const CLOSE_PHRASES = ['bye', 'goodbye', 'have a good', 'have a great', 'talk later', 'take care', 'not interested', 'remove me', 'do not call', 'stop calling'];
function shouldEndCall(text) {
  const lower = text.toLowerCase();
  if (lower.includes('[end]')) return true;
  return CLOSE_PHRASES.some(p => lower.includes(p));
}
function buildSystemPrompt(session) {
  const base = session.prompt || SYSTEM_PROMPT;
  const parts = [base];
  if (session.company) parts.push(`You are calling on behalf of ${session.company}.`);
  if (session.reason)  parts.push(`Background context for this call (use this to guide the conversation, don't recite it): ${session.reason}.`);
  if (session.name)    parts.push(`You are speaking with ${session.name}.`);
  return parts.join(' ');
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

// List user's ElevenLabs voices + search shared library
app.get('/voices', async (req, res) => {
  const search = (req.query.search || '').toLowerCase();
  if (!ELEVENLABS_KEY) return res.status(500).json({ error: 'No ElevenLabs key' });
  try {
    // Get user's own voices
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
  const host = process.env.RAILWAY_PUBLIC_DOMAIN ||
               req.headers['x-forwarded-host'] ||
               req.headers.host || '';
  console.log('[twiml-stream] host:', host, 'n:', n, 'r:', r, 'c:', c, 'method:', req.method);
  const wsUrl = `wss://${host}/twilio`;
  // Pass params as Twilio <Parameter> elements — reliable, no URL-encoding edge cases
  const paramXml = [
    n ? `<Parameter name="n" value="${xmlEsc(n)}"/>` : '',
    r ? `<Parameter name="r" value="${xmlEsc(r)}"/>` : '',
    c ? `<Parameter name="c" value="${xmlEsc(c)}"/>` : '',
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
      const prompt = n || r || c
        ? `${SYSTEM_PROMPT}\nCall context (DO NOT read this out — use it to guide the conversation naturally):\n- Person: ${n || 'unknown'}\n${c ? `- Company: ${c}\n` : ''}- Reason for call: ${r || 'general outreach'}\nBuild rapport first, then steer naturally toward the reason.`
        : SYSTEM_PROMPT;
      session = { callSid, streamSid, twilioWs: ws, browserWs: null, dgWs: null, markResolvers: {}, state: 'greeting', history: [], prompt, name: n, company: c, reason: r, capturedEmail: null, docuSignSent: false };
      sessions.set(callSid, session);
      dgAudioLogged = false;
      callLog(callSid, '[call] started | name:', n || '(none)', '| company:', c || '(none)');
      connectDeepgram(session);
      setTimeout(() => sendGreeting(session), 2500);
    }
    if (msg.event === 'media' && session && session.state === 'listening') {
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
    '&interim_results=true&utterance_end_ms=600&vad_events=true';
  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
  session.dgWs = dg;
  session.dgTranscriptBuf = '';

  dg.on('open', () => {
    if (session.dgWs !== dg) return;
    callLog(session.callSid, '[dg] connected');
    session.dgReconnecting = false;
  });

  dg.on('message', async (data) => {
    if (session.dgWs !== dg) return;
    try {
      const result = JSON.parse(data);

      // Accumulate final transcript chunks as user speaks
      if (result.type === 'Results') {
        const transcript = result?.channel?.alternatives?.[0]?.transcript?.trim();
        if (!transcript) return;
        if (result.is_final) {
          session.dgTranscriptBuf = (session.dgTranscriptBuf + ' ' + transcript).trim();
        }
        // Show interim transcripts in browser for live display
        if (!result.is_final) {
          pushToBrowser(session, { event: 'transcript-interim', speaker: 'prospect', text: transcript });
        }
        return;
      }

      // UtteranceEnd = natural end of turn — now respond
      if (result.type === 'UtteranceEnd') {
        const transcript = session.dgTranscriptBuf.trim();
        session.dgTranscriptBuf = '';
        if (!transcript) return;

        const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|huh|mhm|ah+|oh+|ow+)\s*[.?!]?$/i;
        if (transcript.split(/\s+/).length < 1 || NOISE_ONLY.test(transcript)) return;

        callLog(session.callSid, '[prospect]', transcript, '| state:', session.state);
        pushToBrowser(session, { event: 'transcript', speaker: 'prospect', text: transcript });

        const emailMatch = transcript.match(/\b[a-zA-Z0-9._%+\-]+\s*[@at]+\s*[a-zA-Z0-9.\-]+\s*\.\s*(?:com|net|org|edu|gov|io|co)\b/i);
        if (emailMatch && !session.capturedEmail) {
          const rawEmail = emailMatch[0].replace(/\s+/g, '').replace(/\bat\b/gi, '@');
          session.capturedEmail = rawEmail;
          callLog(session.callSid, '[email] captured:', rawEmail);
          pushToBrowser(session, { event: 'email-captured', email: rawEmail });
        }

        if (session.state !== 'listening') { callLog(session.callSid, '[dg] ignoring — state=' + session.state); return; }
        session.state = 'processing';
        session.history.push({ role: 'user', content: transcript });
        await generateAndSpeak(session);
      }
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
  const n = name || '';
  const c = company || '';
  const who = n ? `Is this ${n}?` : 'Hey, who am I speaking with?';
  const intro = c ? `This is Brandy with ${c}.` : `This is Brandy.`;
  const GREETINGS = [
    `Hey! ${who} ${intro}`,
    `Hi there! ${intro} ${who}`,
    `Hey, how are you? ${intro} ${who}`,
  ];
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
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

  // Stream OpenAI and speak full reply as one continuous TTS call
  const fullReply = await streamOpenAIAndSpeak(session, messages);
  if (!fullReply) { session.state = 'listening'; return; }

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
          callReason: 'switching from paper checks to Avis Pay Direct',
          subject: 'Your Avis Pay Direct Agreement — Please Review & Sign',
          message: `Hi${session.name ? ' ' + session.name : ''},\n\nThank you for speaking with Brandy today! As discussed, please review and sign your Avis Pay Direct agreement using the link below.\n\nIf you have any questions, feel free to reply to this email.`,
          docuSignLink: 'https://www.docusign.com'
        })
      });
      callLog(session.callSid, '[docusign] sent successfully');
      pushToBrowser(session, { event: 'docusign-sent', email: session.capturedEmail });
    } catch (e) {
      callLog(session.callSid, '[docusign] send failed:', e.message);
    }
  }

  // End call if Brandy said goodbye or replied with [END]
  if (shouldEndCall(fullReply)) {
    callLog(session.callSid, '[call] ending call — farewell detected');
    pushToBrowser(session, { event: 'call-ended' });
    setTimeout(() => { try { session.twilioWs?.close(); } catch {} }, 500);
    return;
  }

  session.state = 'listening';
}

function prepareForSpeech(text) {
  return text.trim()
    .replace(/\[END\]/gi, '')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/([^.!?])$/, '$1.')
    .trim();
}

// Collect full OpenAI reply via streaming (faster text delivery), then speak in one TTS call
async function streamOpenAIAndSpeak(session, messages) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 60, temperature: 0.7, stream: true }),
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

    // Clear filler and speak entire reply as one continuous TTS call (no mid-sentence gaps)
    if (session.twilioWs?.readyState === WebSocket.OPEN) {
      session.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
    }
    session.state = 'speaking';
    pushToBrowser(session, { event: 'ai-speaking', text: fullText });
    await streamTTS(session, fullText);

    try { session.dgWs?.terminate(); } catch {}
    session.dgWs = null;
    session.dgReconnecting = true;
    connectDeepgram(session);
    const markName = 'tts-' + Date.now();
    if (sendMark(session, markName)) await awaitMark(session, markName, 10000);

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
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 60, temperature: 0.7 }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { console.error('[openai] error:', e.message); return null; }
}

const ELEVENLABS_VOICE_SETTINGS = {
  model_id: 'eleven_flash_v2_5', apply_text_normalization: 'off',
  voice_settings: { stability: 0.18, similarity_boost: 0.75, style: 0.72, use_speaker_boost: false, speed: 0.86 }
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
  callLog(session.callSid, '[tts] speaking:', text.slice(0, 60));
  pushToBrowser(session, { event: 'ai-speaking', text });
  try {
    await streamTTS(session, text);
  } catch (e) { callLog(session.callSid, '[tts] error:', e.message); }
  // Reconnect DG fresh immediately so it's ready by the time Twilio finishes playing
  try { session.dgWs?.terminate(); } catch {}
  session.dgWs = null;
  session.dgReconnecting = true;
  connectDeepgram(session);
  // Wait for Twilio to confirm audio is done playing before we start listening
  const markName = 'tts-' + Date.now();
  if (sendMark(session, markName)) {
    callLog(session.callSid, '[mark] waiting for playback to complete...');
    await awaitMark(session, markName, 10000);
    callLog(session.callSid, '[mark] playback done — now listening');
  }
  session.state = 'listening';
  pushToBrowser(session, { event: 'ai-done' });
}

async function streamTTS(session, text) {
  if (ELEVENLABS_KEY) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream?output_format=pcm_16000`, {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: prepareForSpeech(text),
          model_id: 'eleven_flash_v2_5',
          voice_settings: { stability: 0.30, similarity_boost: 0.80, style: 0.50, use_speaker_boost: false, speed: 0.82 }
        }),
        signal: ctrl.signal
      });
      clearTimeout(t);
      const ct = resp.headers.get('content-type') || '';
      console.log(`[elevenlabs] status=${resp.status} ct=${ct}`);
      if (resp.ok && ct.includes('audio')) {
        await pipeToTwilio(session, resp, 'pcm16k');
        return;
      }
      const err = await resp.text().catch(() => '');
      console.log('[elevenlabs] error:', err.slice(0, 200));
    } catch (e) {
      console.log('[elevenlabs] failed:', e.message, '— falling back to OpenAI TTS');
    }
  }
  // Fallback: OpenAI TTS
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'tts-1', voice: 'nova', response_format: 'pcm', speed: 1.0, input: prepareForSpeech(text) }),
    signal: ctrl.signal
  });
  clearTimeout(t);
  if (!resp.ok) throw new Error(`OpenAI TTS ${resp.status}`);
  await pipeToTwilio(session, resp, 'pcm24k');
}

async function pipeToTwilio(session, resp, type) {
  const reader = resp.body.getReader();
  let buffer = Buffer.alloc(0);
  const readWithTimeout = () => Promise.race([
    reader.read(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('read timeout')), 8000))
  ]);

  // ulaw_8000 from ElevenLabs is already what Twilio needs — pass straight through
  if (type === 'ulaw8k') {
    const CHUNK = 160; // 20ms at 8kHz
    try {
      while (true) {
        const { done, value } = await readWithTimeout();
        if (done) break;
        if (!value?.length) continue;
        if (session.twilioWs?.readyState !== WebSocket.OPEN) break;
        buffer = Buffer.concat([buffer, Buffer.from(value)]);
        while (buffer.length >= CHUNK) {
          session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: buffer.slice(0, CHUNK).toString('base64') } }));
          buffer = buffer.slice(CHUNK);
        }
      }
      if (buffer.length > 0 && session.twilioWs?.readyState === WebSocket.OPEN) {
        session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: buffer.toString('base64') } }));
      }
    } finally { reader.cancel().catch(() => {}); }
    return;
  }

  // PCM from OpenAI — convert to mulaw
  const chunkBytes = type === 'pcm24k' ? 480 : 320;
  const samplesPerChunk = chunkBytes / 2;
  const encoder = type === 'pcm24k' ? pcm24ToMulaw : pcm16ToMulaw;
  try {
    while (true) {
      const { done, value } = await readWithTimeout();
      if (done) break;
      if (!value?.length) continue;
      if (session.twilioWs?.readyState !== WebSocket.OPEN) break;
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
      while (buffer.length >= chunkBytes) {
        const pcm = new Int16Array(buffer.buffer, buffer.byteOffset, samplesPerChunk);
        session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: encoder(pcm).toString('base64') } }));
        buffer = buffer.slice(chunkBytes);
      }
    }
    if (buffer.length >= 2 && session.twilioWs?.readyState === WebSocket.OPEN) {
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
    // Average 3 samples (box filter) instead of dropping 2 — eliminates aliasing/robot sound
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
  let n = '', r = '', c = '';
  let streamSid    = null;
  let openAiWs     = null;
  let sessionReady = false;
  let pendingAudio = [];
  let greeted      = false;
  let greetTimer   = null;
  let startReceived = false;
  let reconnecting = false;

  const instructions =
    (process.env.AI_SYSTEM_PROMPT ||
    'You are Brandy, a real Southern woman — warm, personable, genuinely likable. ' +
    'You are calling on behalf of Acme Products, which currently sends paper checks to this business. ' +
    'Your goal is to get them to switch to Avis Pay Direct (faster electronic payments) and collect their email to send the agreement. ' +
    'HOW TO RUN THE CALL: ' +
    '1. Confirm you have the right person. ' +
    '2. Mention Acme Products sends them checks and you are calling about a simple payment upgrade. ' +
    '3. Briefly explain Avis Pay Direct — faster than a check, direct to their account, no hassle. ' +
    '4. Handle questions warmly. Never rush or push. ' +
    '5. When they agree, say something like "Perfect! What email should I send that to?" ' +
    '6. Repeat the email back to confirm it, then tell them to expect it shortly. ' +
    'STYLE: Speak like a real Southern woman — unhurried, warm, natural. Match their energy. ' +
    'Keep responses 1 to 2 sentences. Always end with a question or a clear next step. ' +
    'BANNED: "I understand", "Absolutely", "Certainly", "Of course", "Great question".');

  function buildSessionUpdate() {
    const ctx = [instructions];
    if (n) ctx.push(`You are calling to speak with ${n}.`);
    if (c) ctx.push(`Calling on behalf of ${c}.`);
    if (r) ctx.push(`Call purpose: ${r}.`);
    return {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: ctx.join(' '),
        voice: 'coral',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.4,
          prefix_padding_ms: 200,
          silence_duration_ms: 400,
          create_response: true
        },
        temperature: 0.8
      }
    };
  }

  function sendAudio(payload) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (streamSid) {
      ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload } }));
    } else {
      pendingAudio.push(payload);
    }
  }

  function triggerGreeting() {
    if (greeted || openAiWs?.readyState !== WebSocket.OPEN) return;
    greeted = true;
    const who = n ? ` Is this ${n}?` : ' Who am I speaking with?';
    const from = c ? ` from ${c}` : '';
    openAiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
        instructions: `Say hello warmly as Brandy${from}.${who} One sentence only.`
      }
    }));
  }

  function connectOpenAI() {
    openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
    );

    openAiWs.on('open', () => {
      console.log('[realtime] OpenAI connected');
      reconnecting = false;
      if (startReceived) openAiWs.send(JSON.stringify(buildSessionUpdate()));
    });

    openAiWs.on('message', raw => {
      try {
        const ev = JSON.parse(raw);
        if (ev.type !== 'session.created' && ev.type !== 'response.audio.delta') {
          console.log('[realtime]', ev.type, ev.error ? JSON.stringify(ev.error) : '');
        }
        if (ev.type === 'session.updated') {
          sessionReady = true;
          if (streamSid && !greeted) {
            if (greetTimer) clearTimeout(greetTimer);
            greetTimer = setTimeout(triggerGreeting, 1500);
          }
        }
        if (ev.type === 'response.audio.delta' && ev.delta) sendAudio(ev.delta);
        if (ev.type === 'input_audio_buffer.speech_started' && streamSid) {
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
        }
        if (ev.type === 'error') {
          console.error('[realtime] error:', JSON.stringify(ev.error));
        }
      } catch (e) { console.error('[realtime] msg parse error:', e.message); }
    });

    openAiWs.on('close', (code, reason) => {
      console.log('[realtime] OpenAI closed', code, reason?.toString());
      sessionReady = false;
      // Reconnect instead of dropping the call (unless Twilio already hung up)
      if (ws.readyState === WebSocket.OPEN && !reconnecting) {
        reconnecting = true;
        console.log('[realtime] reconnecting to OpenAI...');
        setTimeout(connectOpenAI, 1000);
      }
    });

    openAiWs.on('error', e => console.error('[realtime] ws error:', e.message));
  }

  connectOpenAI();

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        startReceived = true;
        const cp = msg.start?.customParameters || {};
        n = cp.n || ''; r = cp.r || ''; c = cp.c || '';
        console.log('[realtime] start — name:', n || '(none)', 'company:', c || '(none)');
        for (const p of pendingAudio) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: p } }));
        }
        pendingAudio = [];
        if (openAiWs?.readyState === WebSocket.OPEN) {
          openAiWs.send(JSON.stringify(buildSessionUpdate()));
        }
      }
      if (msg.event === 'media' && openAiWs?.readyState === WebSocket.OPEN && sessionReady) {
        openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
      }
      if (msg.event === 'stop') { openAiWs?.close(); }
    } catch {}
  });

  ws.on('close', () => {
    if (greetTimer) clearTimeout(greetTimer);
    reconnecting = false;
    try { openAiWs?.close(); } catch {}
  });
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
