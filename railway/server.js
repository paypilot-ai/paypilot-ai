const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const DEEPGRAM_API_KEY  = process.env.DEEPGRAM_API_KEY;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const ELEVENLABS_KEY    = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE  = process.env.ELEVENLABS_VOICE_ID || 'oWAxZDx7w5VEj9dCyTzz'; // Grace — light Southern accent
const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  'You are Brandy, a real Southern woman on a sales call — warm, personable, and genuinely likable. ' +
  'Your first job is to make the person comfortable talking to you. Build real rapport before anything else. ' +
  'Match their energy. If they are relaxed, be relaxed. If they seem guarded, ease them in slowly — a little humor, a little warmth, let them feel like they are talking to a friend. ' +
  'When they talk, really listen. Reflect back what they said. Make them feel heard. People buy from people they like. ' +
  'When someone asks a real question, give a real thoughtful answer like a human would — never deflect. ' +
  'Once they are comfortable, naturally move the conversation toward why you called. Never rush it. ' +
  'Write the way real people talk — words running together, easy rhythm. Use natural fillers like "mm", "yeah", "well", "you know" when it fits. ' +
  'Keep it 1 to 2 sentences, end with a question that keeps them talking. ' +
  'BANNED: "I understand", "Absolutely", "Certainly", "Of course", "Great question".';

const sessions = new Map();

app.get('/health', (req, res) => res.json({ ok: true, activeCalls: sessions.size }));

app.get('/test', async (req, res) => {
  // Read directly from process.env to bypass module-load caching
  const results = {
    env: {
      DEEPGRAM_API_KEY:  !!process.env.DEEPGRAM_API_KEY,
      OPENAI_API_KEY:    !!process.env.OPENAI_API_KEY,
      ELEVENLABS_API_KEY:!!process.env.ELEVENLABS_API_KEY,
      ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID || '(not set)',
      allKeys: Object.keys(process.env).filter(k => !k.includes('SECRET') && !k.includes('TOKEN') && !k.includes('KEY') && !k.includes('SID'))
    },
    openai: null,
    elevenlabs: null
  };

  // Test OpenAI
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'Say "ok"' }], max_tokens: 5 })
    });
    const d = await r.json();
    results.openai = r.ok ? 'OK: ' + d.choices?.[0]?.message?.content : 'ERROR: ' + JSON.stringify(d);
  } catch (e) { results.openai = 'EXCEPTION: ' + e.message; }

  // Test ElevenLabs
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'test', model_id: 'eleven_turbo_v2', output_format: 'pcm_16000' })
    });
    results.elevenlabs = r.ok ? 'OK: got ' + r.headers.get('content-length') + ' bytes' : 'ERROR: ' + await r.text();
  } catch (e) { results.elevenlabs = 'EXCEPTION: ' + e.message; }

  res.json(results);
});

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/twilio') {
    handleTwilio(ws);
  } else if (url.pathname === '/twilio-realtime') {
    handleTwilioRealtime(ws, url.searchParams);
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
      session = {
        callSid, streamSid, twilioWs: ws,
        browserWs: null, dgWs: null,
        state: 'greeting',
        history: []
      };
      sessions.set(callSid, session);
      console.log('[call] started', callSid);
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

  ws.on('close', () => {
    if (session) {
      cleanup(session);
      sessions.delete(session.callSid);
    }
  });
}

function handleBrowser(ws, callSid) {
  if (callSid && sessions.has(callSid)) {
    sessions.get(callSid).browserWs = ws;
    ws.send(JSON.stringify({ event: 'connected', callSid }));
  }
  ws.on('close', () => {
    if (callSid && sessions.has(callSid)) {
      sessions.get(callSid).browserWs = null;
    }
  });
}

function connectDeepgram(session) {
  const dgUrl = 'wss://api.deepgram.com/v1/listen' +
    '?encoding=mulaw&sample_rate=8000&channels=1' +
    '&model=nova-2&punctuate=true&smart_format=true' +
    '&interim_results=false&endpointing=700&utterance_end_ms=1800';

  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
  session.dgWs = dg;

  dg.on('open', () => console.log('[deepgram] connected for', session.callSid));

  dg.on('message', async (data) => {
    const result = JSON.parse(data);
    const transcript = result?.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript || !result.is_final) return;

    // Ignore noise: must be at least 3 words and have meaningful content
    const words = transcript.split(/\s+/).filter(Boolean);
    const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|huh|yeah|yep|ok|okay|right|sure|mhm|ah+|oh+|ow+|ha+)\s*[.?!]?$/i;
    if (words.length < 3 || NOISE_ONLY.test(transcript)) {
      console.log('[prospect] ignored (noise):', transcript);
      return;
    }

    console.log('[prospect]', transcript);
    pushToBrowser(session, { event: 'transcript', speaker: 'prospect', text: transcript });

    if (session.state !== 'listening') return;
    session.state = 'processing';
    session.history.push({ role: 'user', content: transcript });
    await generateAndSpeak(session);
  });

  dg.on('error', (e) => console.error('[deepgram] error:', e.message));
  dg.on('close', () => console.log('[deepgram] closed'));
}

async function sendGreeting(session) {
  const greeting = await callOpenAI([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: 'The call just connected. Give a short professional opening greeting.' }
  ]);
  if (greeting) {
    session.history.push({ role: 'assistant', content: greeting });
    pushToBrowser(session, { event: 'ai-response', text: greeting });
    await speakToTwilio(session, greeting);
  }
  session.state = 'listening';
}

const FILLER_PHRASES = [
  'Yeah, sure.',
  'Oh, for sure.',
  'Right, so...',
  'Yeah, good question.',
  'Mm, let me think on that.',
  'Yeah, I hear you.',
  'Sure, one sec.',
  'Mm-hmm, okay.',
  'Right, yeah.',
  'Oh, totally.',
];

function pickFiller() {
  return FILLER_PHRASES[Math.floor(Math.random() * FILLER_PHRASES.length)];
}

async function generateAndSpeak(session) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...session.history.slice(-12)
  ];

  // Fire filler immediately (don't await) to fill silence while OpenAI runs
  speakFiller(session, pickFiller()).catch(() => {});

  // Get OpenAI reply — this is the actual bottleneck
  const reply = await callOpenAI(messages);

  if (!reply) { session.state = 'listening'; return; }

  // Clear any filler audio still playing before speaking the real response
  if (session.twilioWs?.readyState === WebSocket.OPEN) {
    session.twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
  }

  session.history.push({ role: 'assistant', content: reply });
  pushToBrowser(session, { event: 'ai-response', text: reply });
  await speakToTwilio(session, reply);
  session.state = 'listening';
}

// Make text sound more natural when spoken by ElevenLabs
function prepareForSpeech(text) {
  return text
    .trim()
    // em dash -> natural pause with comma
    .replace(/\s*—\s*/g, ', ')
    // "so " at start of clause after comma -> slight beat
    .replace(/,\s*(so|and|but|because)\s+/gi, (_, w) => `, ${w} `)
    // spaces before punctuation
    .replace(/\s+([.,!?])/g, '$1')
    // ensure ends with punctuation
    .replace(/([^.!?])$/, '$1.');
}

const ELEVENLABS_FILLER_SETTINGS = {
  model_id: 'eleven_flash_v2_5',
  output_format: 'pcm_16000',
  apply_text_normalization: 'off',
  voice_settings: { stability: 0.25, similarity_boost: 0.75, style: 0.50, speed: 0.88 }
};

const ELEVENLABS_VOICE_SETTINGS = {
  model_id: 'eleven_flash_v2_5',
  output_format: 'pcm_16000',
  optimize_streaming_latency: 4,
  apply_text_normalization: 'off',
  voice_settings: { stability: 0.18, similarity_boost: 0.75, style: 0.72, use_speaker_boost: true, speed: 0.86 }
};

async function callOpenAI(messages) {
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 55, temperature: 0.7 })
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('[openai] error:', e.message);
    return null;
  }
}

async function speakFiller(session, text) {
  if (session.twilioWs?.readyState !== WebSocket.OPEN) return;
  pushToBrowser(session, { event: 'ai-speaking', text });
  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: prepareForSpeech(text), ...ELEVENLABS_VOICE_SETTINGS })
      }
    );
    if (!resp.ok) return;
    const reader = resp.body.getReader();
    let buffer = Buffer.alloc(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (session.twilioWs?.readyState !== WebSocket.OPEN) break;
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
      while (buffer.length >= 320) {
        const chunk = buffer.slice(0, 320);
        buffer = buffer.slice(320);
        const pcm16k = new Int16Array(chunk.buffer, chunk.byteOffset, 160);
        const mulaw = pcm16ToMulaw(pcm16k);
        session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: mulaw.toString('base64') } }));
      }
    }
    if (buffer.length >= 2 && session.twilioWs?.readyState === WebSocket.OPEN) {
      const pcm16k = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
      session.twilioWs.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: pcm16ToMulaw(pcm16k).toString('base64') } }));
    }
  } catch (_) {}
}

async function speakToTwilio(session, text) {
  if (session.twilioWs?.readyState !== WebSocket.OPEN) return;
  session.state = 'speaking';
  console.log('[ai]', text.slice(0, 80));
  pushToBrowser(session, { event: 'ai-speaking', text });

  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: prepareForSpeech(text), ...ELEVENLABS_VOICE_SETTINGS })
      }
    );

    if (!resp.ok) {
      const err = await resp.text();
      console.error('[elevenlabs] error:', err);
      session.state = 'listening';
      pushToBrowser(session, { event: 'ai-done' });
      return;
    }

    const reader = resp.body.getReader();
    let buffer = Buffer.alloc(0);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (session.twilioWs?.readyState !== WebSocket.OPEN) break;

      // Accumulate PCM16 16kHz data, convert to mulaw 8kHz in 160-sample chunks
      buffer = Buffer.concat([buffer, Buffer.from(value)]);

      // Process complete 320-byte chunks (160 samples at 16kHz = 160 samples at 8kHz after downsample)
      while (buffer.length >= 320) {
        const chunk = buffer.slice(0, 320);
        buffer = buffer.slice(320);
        const pcm16k = new Int16Array(chunk.buffer, chunk.byteOffset, 160);
        const mulaw = pcm16ToMulaw(pcm16k);
        session.twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: { payload: mulaw.toString('base64') }
        }));
      }
    }

    // Flush remaining samples
    if (buffer.length >= 2 && session.twilioWs?.readyState === WebSocket.OPEN) {
      const pcm16k = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
      const mulaw = pcm16ToMulaw(pcm16k);
      session.twilioWs.send(JSON.stringify({
        event: 'media',
        streamSid: session.streamSid,
        media: { payload: mulaw.toString('base64') }
      }));
    }

  } catch (e) {
    console.error('[elevenlabs] stream error:', e.message);
  }

  session.state = 'listening';
  pushToBrowser(session, { event: 'ai-done' });
}

// PCM16 16kHz → mulaw 8kHz (downsample 2:1 + encode)
function pcm16ToMulaw(samples) {
  const BIAS = 0x84;
  const CLIP = 32635;
  const out = Buffer.allocUnsafe(Math.floor(samples.length / 2));
  for (let i = 0; i < out.length; i++) {
    let s = samples[i * 2]; // downsample: take every other sample
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    if (s > CLIP) s = CLIP;
    s += BIAS;
    let exp = 7;
    let mask = 0x4000;
    while (exp > 0 && (s & mask) === 0) { exp--; mask >>= 1; }
    const mantissa = (s >> (exp + 3)) & 0x0F;
    out[i] = ~(sign | (exp << 4) | mantissa) & 0xFF;
  }
  return out;
}

function pushToBrowser(session, data) {
  if (session.browserWs?.readyState === WebSocket.OPEN) {
    session.browserWs.send(JSON.stringify(data));
  }
}

function cleanup(session) {
  try { session.dgWs?.close(); } catch {}
}

// ── OPENAI REALTIME — AI CALLER ──────────────────────────────────
function handleTwilioRealtime(ws, params) {
  const n = params.get('n') || '';
  const r = params.get('r') || '';
  const c = params.get('c') || '';

  const company = c || 'our company';
  const name    = n || 'the prospect';
  const reason  = r || '';

  const instructions =
    `You are Brandy, a warm Southern woman on a live outbound call for ${company}.${reason ? ` Calling about: ${reason}.` : ''} Talking to ${name}.

You are NOT a bot. You are a real person who happens to be great at sales. You genuinely enjoy talking to people.

PACING AND DELIVERY:
- Speak naturally — unhurried, like you have all the time in the world.
- Leave real breath space after sentences. Never rush from one thought to the next.
- On questions, let your tone lift gently at the end — curious, not flat.
- When something matters, slow down slightly on that word so it lands.
- Mmm and "yeah" land best when you pause first, then say them.

CONVERSATION STYLE:
- Match their energy exactly. Guarded? Be patient and warm. Chatty? Match that warmth.
- Really listen to what they say and react to it specifically — not generically.
- Use natural fillers: "mm", "yeah", "oh", "well", "you know" — but only when they feel real.
- Say ONE thing, then stop. Let them talk. Silence is okay.
- When they ask a real question, give a real thoughtful answer like a friend would.
- Work toward why you called only once they seem comfortable. Never push.

BANNED WORDS: "I understand", "Absolutely", "Certainly", "Of course", "Great question", "Definitely", "For sure".`;

  let streamSid = null;
  let openAiWs  = null;
  let sessionReady = false;

  function connectOpenAI() {
    openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
    );

    openAiWs.on('open', () => {
      openAiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          instructions,
          voice: 'coral',
          input_audio_format: 'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 200,
            silence_duration_ms: 400
          },
          temperature: 0.8,
          max_response_output_tokens: 60
        }
      }));
      sessionReady = true;
      console.log('[realtime] OpenAI connected');
    });

    openAiWs.on('message', raw => {
      try {
        const ev = JSON.parse(raw);

        if (ev.type === 'response.audio.delta' && ev.delta && streamSid) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: ev.delta }
          }));
        }

        if (ev.type === 'input_audio_buffer.speech_started' && streamSid) {
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
        }

        if (ev.type === 'error') {
          console.error('[realtime] OpenAI error:', JSON.stringify(ev.error));
        }
      } catch {}
    });

    openAiWs.on('close', () => console.log('[realtime] OpenAI disconnected'));
    openAiWs.on('error', e => console.error('[realtime] OpenAI ws error:', e.message));
  }

  connectOpenAI();

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('[realtime] stream started', streamSid);
      }

      if (msg.event === 'media' && openAiWs?.readyState === WebSocket.OPEN && sessionReady) {
        openAiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }

      if (msg.event === 'stop') {
        openAiWs?.close();
      }
    } catch {}
  });

  ws.on('close', () => openAiWs?.close());
  ws.on('error', e => console.error('[realtime] Twilio ws error:', e.message));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PayPilot AI server on :${PORT}`));
