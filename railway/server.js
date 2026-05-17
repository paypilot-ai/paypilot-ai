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
const ELEVENLABS_VOICE  = process.env.ELEVENLABS_VOICE_ID || 'oWAxZDx7w5VEj9dCyTzz';
const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  'You are Brandy, a real Southern woman on a sales call — warm, personable, and genuinely likable. ' +
  'Your first job is to make the person comfortable talking to you. Build real rapport before anything else. ' +
  'Match their energy. If they are relaxed, be relaxed. If they seem guarded, ease them in slowly. ' +
  'When they talk, really listen. Reflect back what they said. Make them feel heard. ' +
  'When someone asks a real question, give a real thoughtful answer like a human would — never deflect. ' +
  'Once they are comfortable, naturally move the conversation toward why you called. Never rush it. ' +
  'Use natural fillers like "mm", "yeah", "well", "you know" when it fits. ' +
  'Keep it 1 to 2 sentences, end with a question that keeps them talking. ' +
  'BANNED: "I understand", "Absolutely", "Certainly", "Of course", "Great question".';

const sessions = new Map();

app.get('/health', (req, res) => res.json({ ok: true, activeCalls: sessions.size }));

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
    elevenlabs: null
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
        ? `${SYSTEM_PROMPT}\nYou are calling to speak with ${n || 'the prospect'}${c ? ` from ${c}` : ''}.${r ? ` Purpose of call: ${r}.` : ''}`
        : SYSTEM_PROMPT;
      session = { callSid, streamSid, twilioWs: ws, browserWs: null, dgWs: null, state: 'greeting', history: [], prompt, name: n, company: c, reason: r };
      sessions.set(callSid, session);
      console.log('[call] started', callSid, '| name:', n || '(none)', '| company:', c || '(none)');
      connectDeepgram(session);
      setTimeout(() => sendGreeting(session), 1200);
    }
    if (msg.event === 'media' && session) {
      if (session.state !== 'listening') return;
      if (session.dgWs?.readyState !== WebSocket.OPEN) return;
      const mulaw = Buffer.from(msg.media.payload, 'base64');
      session.dgWs.send(mulaw);
    }
    if (msg.event === 'stop' && session) {
      console.log('[call] ended', session.callSid);
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
    '&interim_results=false&endpointing=150&utterance_end_ms=400';
  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
  session.dgWs = dg;
  dg.on('open', () => console.log('[deepgram] connected for', session.callSid));
  dg.on('message', async (data) => {
    try {
      const result = JSON.parse(data);
      const transcript = result?.channel?.alternatives?.[0]?.transcript?.trim();
      if (!transcript || !result.is_final) return;
      const words = transcript.split(/\s+/).filter(Boolean);
      const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|huh|mhm|ah+|oh+|ow+|ha+)\s*[.?!]?$/i;
      if (words.length < 1 || NOISE_ONLY.test(transcript)) return;
      console.log('[prospect]', transcript);
      pushToBrowser(session, { event: 'transcript', speaker: 'prospect', text: transcript });
      if (session.state !== 'listening') return;
      session.state = 'processing';
      session.history.push({ role: 'user', content: transcript });
      await generateAndSpeak(session);
    } catch (e) { console.error('[deepgram] message handler error:', e.message); }
  });
  dg.on('error', (e) => console.error('[deepgram] error:', e.message));
  dg.on('close', () => console.log('[deepgram] closed'));
}

async function sendGreeting(session) {
  const name    = session.name    || 'the prospect';
  const company = session.company || '';
  const reason  = session.reason  || '';
  const greetPrompt = `The call just connected. Give a short warm Southern greeting. Say your name is Brandy${company ? `, calling from ${company}` : ''}.${reason ? ` Mention you are calling about ${reason}.` : ''} Ask if ${name} is available.`;
  const greeting = await callOpenAI([
    { role: 'system', content: session.prompt || SYSTEM_PROMPT },
    { role: 'user', content: greetPrompt }
  ]);
  if (greeting) {
    session.history.push({ role: 'assistant', content: greeting });
    pushToBrowser(session, { event: 'ai-response', text: greeting });
    await speakToTwilio(session, greeting);
  }
  session.state = 'listening';
}

async function generateAndSpeak(session) {
  const messages = [{ role: 'system', content: session.prompt || SYSTEM_PROMPT }, ...session.history.slice(-12)];
  const reply = await callOpenAI(messages);
  if (!reply) { session.state = 'listening'; return; }
  session.history.push({ role: 'assistant', content: reply });
  pushToBrowser(session, { event: 'ai-response', text: reply });
  await speakToTwilio(session, reply);
  session.state = 'listening';
}

function prepareForSpeech(text) {
  return text.trim()
    .replace(/\s*—\s*/g, ', ')
    .replace(/\s+([.,!?])/g, '$1')
    .replace(/([^.!?])$/, '$1.');
}

const DG_TTS_URL = 'https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none';

async function callOpenAI(messages) {
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 55, temperature: 0.7 })
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { console.error('[openai] error:', e.message); return null; }
}

async function speakToTwilio(session, text) {
  if (session.twilioWs?.readyState !== WebSocket.OPEN) return;
  session.state = 'speaking';
  console.log('[ai]', text.slice(0, 80));
  pushToBrowser(session, { event: 'ai-speaking', text });
  try {
    const resp = await fetch(DG_TTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Token ${DEEPGRAM_API_KEY}` },
      body: JSON.stringify({ text: prepareForSpeech(text) })
    });
    if (!resp.ok) { console.error('[tts] error:', await resp.text()); }
    else { await streamMulawToTwilio(session, resp); }
  } catch (e) { console.error('[tts] error:', e.message); }
  session.state = 'listening';
  pushToBrowser(session, { event: 'ai-done' });
}

async function streamMulawToTwilio(session, resp) {
  const reader = resp.body.getReader();
  let buffer = Buffer.alloc(0);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    if (session.twilioWs?.readyState !== WebSocket.OPEN) break;
    buffer = Buffer.concat([buffer, Buffer.from(value)]);
    while (buffer.length >= 160) {
      const chunk = buffer.slice(0, 160); buffer = buffer.slice(160);
      session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: chunk.toString('base64') } }));
    }
  }
  if (buffer.length > 0 && session.twilioWs?.readyState === WebSocket.OPEN) {
    session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: buffer.toString('base64') } }));
  }
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
