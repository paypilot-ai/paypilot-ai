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
const ELEVENLABS_VOICE  = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const SYSTEM_PROMPT     = process.env.AI_SYSTEM_PROMPT ||
  'You are a professional AI collections agent. Be concise — respond in 1-2 sentences. ' +
  'Your goal is to collect payment or arrange a payment plan. Be polite and compliant.';

const sessions = new Map();

app.get('/health', (req, res) => res.json({ ok: true, activeCalls: sessions.size }));

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/twilio') {
    handleTwilio(ws);
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
    '&interim_results=false&endpointing=600&utterance_end_ms=1200';

  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
  session.dgWs = dg;

  dg.on('open', () => console.log('[deepgram] connected for', session.callSid));

  dg.on('message', async (data) => {
    const result = JSON.parse(data);
    const transcript = result?.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript || !result.is_final) return;

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

async function generateAndSpeak(session) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...session.history.slice(-12)
  ];
  const reply = await callOpenAI(messages);
  if (!reply) { session.state = 'listening'; return; }
  session.history.push({ role: 'assistant', content: reply });
  pushToBrowser(session, { event: 'ai-response', text: reply });
  await speakToTwilio(session, reply);
  session.state = 'listening';
}

async function callOpenAI(messages) {
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 120 })
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error('[openai] error:', e.message);
    return null;
  }
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
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          output_format: 'ulaw_8000',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      }
    );

    if (!resp.ok) {
      console.error('[elevenlabs]', await resp.text());
      return;
    }

    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      if (session.twilioWs?.readyState !== WebSocket.OPEN) break;
      for (let i = 0; i < value.length; i += 160) {
        const chunk = value.slice(i, i + 160);
        session.twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: { payload: Buffer.from(chunk).toString('base64') }
        }));
      }
    }
  } catch (e) {
    console.error('[elevenlabs] stream error:', e.message);
  }

  pushToBrowser(session, { event: 'ai-done' });
}

function pushToBrowser(session, data) {
  if (session.browserWs?.readyState === WebSocket.OPEN) {
    session.browserWs.send(JSON.stringify(data));
  }
}

function cleanup(session) {
  try { session.dgWs?.close(); } catch {}
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`PayPilot AI server on :${PORT}`));
