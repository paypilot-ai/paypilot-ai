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
const ELEVENLABS_VOICE  = process.env.ELEVENLABS_VOICE_ID || 'tnSpp4vdxKPjI9w0GnoV';
const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  'You are Brandy — a real Southern woman making an outbound sales call. You grew up in Georgia. ' +
  'You talk the way Southern women actually talk: easy, warm, a little drawly. You take your time. You listen. ' +
  'You use real Southern expressions naturally — "well now", "shoot", "I tell you what", "honey", "y\'all", "bless your heart" — but only when they fit, never forced. ' +
  'You are genuinely charming, a little flirty but always professional. You make people feel like they\'re talking to a friend who happens to be calling about something. ' +
  'HOW YOU SPEAK: ' +
  'ONE sentence per turn. Hard limit. Then stop and let them respond. ' +
  'Never explain, never list, never follow up your own sentence. Say one thing, ask one question if needed, then wait. ' +
  'React to exactly what they just said. Mirror their energy — if they\'re warm, be warm. If they\'re short, be quick and respectful. ' +
  'If they push back or say not interested — acknowledge it warmly, try once more from a different angle. Never give up on the first no. ' +
  '[END] RULE: Only append [END] after both parties have fully said their goodbyes — like "bye now", "take care", "goodbye". NEVER use [END] in a greeting, opening line, or mid-conversation. Most calls will NOT end with [END]. ' +
  'BANNED WORDS: "Absolutely", "Certainly", "Of course", "Great question", "Definitely", "I understand", "I appreciate", "Fantastic".';

function shouldEndCall(text, history) {
  if (!text.toLowerCase().includes('[end]')) return false;
  // Require at least 6 history entries (~3 exchanges) before allowing hangup
  // Prevents AI from misfiring [END] on first response
  return (history?.length ?? 0) >= 6;
}
function buildSystemPrompt(session) {
  const base = session.prompt || SYSTEM_PROMPT;
  const parts = [base];
  if (session.company) parts.push(`You are calling on behalf of ${session.company}.`);
  if (session.reason)  parts.push(`PURPOSE OF THIS CALL: ${session.reason}. This is why you are calling — weave it naturally into the conversation and keep coming back to it.`);
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
      session = { callSid, streamSid, twilioWs: ws, browserWs: null, dgWs: null, markResolvers: {}, ttsAbort: null, bargedIn: false, greetingTimer: null, state: 'greeting', history: [], prompt: null, name: n, company: c, reason: r, capturedEmail: null, docuSignSent: false };
      sessions.set(callSid, session);
      dgAudioLogged = false;
      callLog(callSid, '[call] started | name:', n || '(none)', '| company:', c || '(none)');
      connectDeepgram(session);
      // Wait for prospect to say hello first; fallback greets after 2s if they stay silent
      session.greetingTimer = setTimeout(() => sendGreeting(session), 2000);
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
    '&interim_results=false&endpointing=200';
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

      // Any speech triggers the greeting — check before noise filter
      if (session.state === 'greeting') {
        callLog(session.callSid, '[dg] prospect spoke — greeting now:', transcript);
        clearTimeout(session.greetingTimer);
        session.greetingTimer = null;
        sendGreeting(session);
        return;
      }

      const words = transcript.split(/\s+/).filter(Boolean);
      const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|huh|mhm|ah+|oh+|ow+|ha+)\s*[.?!]?$/i;
      // Passive acknowledgments that are NOT meant as interruptions
      const PASSIVE = /^(yeah|yep|yup|okay|ok|sure|right|alright|gotcha|got\s*it|cool|great|good|fine|sounds\s*good|makes\s*sense)\s*[.?!]?$/i;
      if (words.length < 2 || NOISE_ONLY.test(transcript) || PASSIVE.test(transcript)) {
        callLog(session.callSid, '[dg] filtered noise/passive:', transcript);
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
      if (session.state === 'speaking') {
        // Barge-in: customer interrupted — stop Brandy immediately
        callLog(session.callSid, '[barge-in]', transcript);
        if (session.twilioWs?.readyState === WebSocket.OPEN) {
          session.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
        }
        session.bargedIn = true;
        session.ttsAbort?.abort();
        for (const resolve of Object.values(session.markResolvers)) resolve();
        session.markResolvers = {};
        session.pendingTranscript = transcript;
        return;
      }
      if (session.state !== 'listening') {
        session.pendingTranscript = transcript;
        callLog(session.callSid, '[dg] buffered (state=' + session.state + '):', transcript);
        return;
      }
      session.pendingTranscript = null;
      session.state = 'processing';
      session.history.push({ role: 'user', content: transcript });
      try {
        await generateAndSpeak(session);
      } catch (e) {
        callLog(session.callSid, '[ai] error — resetting to listening:', e.message);
        session.state = 'listening';
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
  const ask = n ? `Is ${n} around?` : `Who am I speaking with today?`;
  const intro = c ? `This is Brandy over at ${c}.` : `This is Brandy.`;
  const GREETINGS = [
    `Hey! ${intro} ${ask}`,
    `Hi there! ${intro} ${ask}`,
    `Hey, how's it going? ${intro} ${ask}`,
    `Hey there — ${intro} ${ask}`,
    `Hi! ${intro} ${ask}`,
  ];
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}

async function sendGreeting(session) {
  if (session.state !== 'greeting') return; // guard: only fire once
  session.state = 'speaking'; // claim state synchronously before any await
  const greeting = buildGreeting(session.name, session.company);
  session.history.push({ role: 'assistant', content: greeting });
  pushToBrowser(session, { event: 'ai-response', text: greeting });
  try {
    await speakToTwilio(session, greeting);
  } catch (e) {
    callLog(session.callSid, '[greeting] tts error:', e.message);
  }
  enterListening(session);
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
  callLog(session.callSid, '[ai] generating...');
  const messages = [{ role: 'system', content: buildSystemPrompt(session) }, ...session.history.slice(-6)];

  // 1. Fetch AI reply (state stays 'processing' during fetch — barge-in buffers to pendingTranscript)
  const fullReply = await fetchAIReply(messages);
  if (!fullReply) { enterListening(session); return; }

  callLog(session.callSid, '[ai] reply:', fullReply.slice(0, 80));

  // 2. Save to history BEFORE speaking — barge-in can't corrupt it
  session.history.push({ role: 'assistant', content: fullReply });
  pushToBrowser(session, { event: 'ai-response', text: fullReply });

  // 3. DocuSign auto-send
  if (session.capturedEmail && !session.docuSignSent) {
    session.docuSignSent = true;
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
    }).then(() => {
      callLog(session.callSid, '[docusign] sent');
      pushToBrowser(session, { event: 'docusign-sent', email: session.capturedEmail });
    }).catch(e => callLog(session.callSid, '[docusign] failed:', e.message));
  }

  // 4. End call check
  if (shouldEndCall(fullReply, session.history)) {
    callLog(session.callSid, '[call] ending');
    pushToBrowser(session, { event: 'call-ended' });
    session.state = 'speaking';
    session.ttsAbort = new AbortController();
    try { await streamTTS(session, prepareForSpeech(fullReply)); } catch (_) {}
    setTimeout(() => { try { session.twilioWs?.close(); } catch {} }, 1000);
    return;
  }

  // 5. Speak reply
  session.state = 'speaking';
  session.bargedIn = false;
  session.ttsAbort = new AbortController();
  if (session.twilioWs?.readyState === WebSocket.OPEN) {
    session.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
  }
  pushToBrowser(session, { event: 'ai-speaking', text: fullReply });
  try {
    await streamTTS(session, fullReply);
    const markName = 'tts-' + Date.now();
    if (sendMark(session, markName)) await awaitMark(session, markName, 2000);
  } catch (_) {}
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

// Streams AI tokens, calls onSentence(text) as soon as a sentence boundary is
// detected so TTS can start early. Returns the full reply text.
async function fetchAIReply(messages, onSentence) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 25, temperature: 0.7, stream: true }),
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', fullText = '', sentenceFired = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6);
        if (d === '[DONE]') break;
        try {
          const tok = JSON.parse(d).choices?.[0]?.delta?.content;
          if (tok) {
            fullText += tok;
            // Fire as soon as we have a complete sentence (~10+ chars ending in . ! ?)
            if (!sentenceFired && onSentence && fullText.length > 10 && /[.!?]/.test(fullText)) {
              sentenceFired = true;
              onSentence(fullText.trim());
            }
          }
        } catch {}
      }
    }
    return fullText.trim() || null;
  } catch (e) { callLog('?', '[ai] fetch error:', e.message); return null; }
}

const ELEVENLABS_VOICE_SETTINGS = {
  model_id: 'eleven_turbo_v2_5',
  voice_settings: { stability: 0.35, similarity_boost: 0.75, style: 0.25, use_speaker_boost: false, speed: 1.0 }
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
  session.ttsAbort = new AbortController();
  callLog(session.callSid, '[tts] speaking:', text.slice(0, 60));
  pushToBrowser(session, { event: 'ai-speaking', text });
  try {
    await streamTTS(session, text);
  } catch (e) { callLog(session.callSid, '[tts] error:', e.message); }
  const markName = 'tts-' + Date.now();
  if (sendMark(session, markName)) await awaitMark(session, markName, 2000);
  enterListening(session);
}

async function streamTTS(session, text) {
  // session.ttsAbort is set by the caller before invoking this function
  const abort = session.ttsAbort;
  if (abort?.signal.aborted) return;

  const prepared = prepareForSpeech(text);

  if (ELEVENLABS_KEY) {
    try {
      const elTimeout = setTimeout(() => abort?.abort(), 8000);
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream?output_format=pcm_16000&optimize_streaming_latency=4`, {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: prepared, ...ELEVENLABS_VOICE_SETTINGS }),
        signal: abort?.signal
      });
      clearTimeout(elTimeout);
      if (session.bargedIn) return; // interrupted during fetch — stop cleanly
      console.log(`[elevenlabs] status=${resp.status}`);
      if (resp.ok) {
        await pipeToTwilio(session, resp, 'pcm16k');
        return;
      }
      console.log('[elevenlabs] non-ok — falling back to OpenAI TTS');
    } catch (e) {
      if (session.bargedIn) return; // barge-in — stop cleanly, don't fall through
      console.log('[elevenlabs] timeout/error:', e.message, '— falling back to OpenAI TTS');
    }
  }

  if (session.bargedIn) return;
  const t2 = setTimeout(() => abort?.abort(), 12000);
  const resp = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'tts-1', voice: 'shimmer', response_format: 'pcm', speed: 1.0, input: prepared }),
    signal: abort?.signal
  });
  clearTimeout(t2);
  if (abort?.signal.aborted) return;
  if (!resp.ok) throw new Error(`OpenAI TTS ${resp.status}`);
  await pipeToTwilio(session, resp, 'pcm24k');
}

async function pipeToTwilio(session, resp, type) {
  const reader = resp.body.getReader();
  let buffer = Buffer.alloc(0);
  const readWithTimeout = () => Promise.race([
    reader.read(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('read timeout')), 8000)),
    new Promise((_, rej) => {
      if (session.ttsAbort?.signal.aborted) { rej(new Error('tts aborted')); return; }
      session.ttsAbort?.signal.addEventListener('abort', () => rej(new Error('tts aborted')), { once: true });
    })
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

  // PCM → mulaw; 160 mulaw bytes = 20ms at 8kHz (Twilio standard chunk)
  // pcm16k: need 320 Int16 samples (640 bytes) → 160 mulaw bytes
  // pcm24k: need 480 Int16 samples (960 bytes) → 160 mulaw bytes
  const chunkBytes = type === 'pcm24k' ? 960 : 640;
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

function cleanup(session) {
  clearTimeout(session.greetingTimer);
  try { session.ttsAbort?.abort(); } catch {}
  try { session.dgWs?.close(); } catch {}
}

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
