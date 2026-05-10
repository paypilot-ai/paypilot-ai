'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'; // Rachel

const httpServer = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end('PayPilot Voice Server running');
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws) => {
  const session = new CallSession(ws);
  session.init();
});

class CallSession {
  constructor(ws) {
    this.ws = ws;
    this.streamSid = null;
    this.dgWs = null;
    this.history = [];
    this.config = {};
    this.aiSpeaking = false;
    this.generating = false;
    this.pendingTranscript = '';
    this.rejectionCount = 0;
  }

  init() {
    this.ws.on('message', (raw) => {
      try { this.onTwilioMessage(JSON.parse(raw)); } catch {}
    });
    this.ws.on('close', () => this.cleanup());
    this.ws.on('error', (e) => console.error('[Twilio WS]', e.message));
  }

  onTwilioMessage(msg) {
    switch (msg.event) {
      case 'start':
        this.streamSid = msg.start.streamSid;
        this.config = msg.start.customParameters || {};
        console.log(`[Call] Started — rep: ${this.config.repName || 'Alex'}, to: ${this.config.toNumber || '?'}`);
        this.connectDeepgram();
        break;

      case 'media':
        if (this.dgWs?.readyState === WebSocket.OPEN) {
          this.dgWs.send(Buffer.from(msg.media.payload, 'base64'));
        }
        break;

      case 'stop':
        console.log('[Call] Stopped');
        this.cleanup();
        break;
    }
  }

  connectDeepgram() {
    const params = new URLSearchParams({
      model: 'nova-2-phonecall',
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      utterance_end_ms: '1200',
      endpointing: '400',
    });

    this.dgWs = new WebSocket(
      'wss://api.deepgram.com/v1/listen?' + params,
      { headers: { Authorization: 'Token ' + DEEPGRAM_KEY } }
    );

    this.dgWs.on('open', () => {
      console.log('[Deepgram] Connected');
      const name = this.config.repName || 'Alex';
      const company = this.config.company || 'PayPilot AI';
      const opener = this.config.openingLine ||
        `Hi, this is ${name} calling from ${company} — do you have just two minutes? I wanted to share something that's been helping sales teams close a lot more deals.`;
      this.speak(opener);
    });

    this.dgWs.on('message', (raw) => {
      try { this.onDeepgramMessage(JSON.parse(raw)); } catch {}
    });

    this.dgWs.on('error', (e) => console.error('[Deepgram]', e.message));
    this.dgWs.on('close', () => console.log('[Deepgram] Closed'));
  }

  onDeepgramMessage(msg) {
    if (msg.type !== 'Results') return;
    const transcript = msg.channel?.alternatives?.[0]?.transcript?.trim();
    if (!transcript) return;

    if (!msg.is_final) {
      // Interrupt AI if prospect speaks while it's talking
      if (this.aiSpeaking && transcript.length > 5) {
        this.clearAudio();
      }
      return;
    }

    this.handleProspectTurn(transcript);
  }

  async handleProspectTurn(text) {
    if (this.generating) return;
    console.log('[Prospect]', text);

    this.generating = true;
    this.history.push({ role: 'user', content: text });

    try {
      const reply = await this.generateReply();
      if (!reply) return;

      const endCall = reply.includes('[END_CALL]');
      const clean = reply.replace('[END_CALL]', '').trim();
      this.history.push({ role: 'assistant', content: clean });
      console.log('[AI]', clean);

      await this.speak(clean);
      if (endCall) setTimeout(() => this.ws.close(), 2500);
    } catch (e) {
      console.error('[handleProspectTurn]', e.message);
    } finally {
      this.generating = false;
    }
  }

  async generateReply() {
    const cfg = this.config;

    const productSection = [
      cfg.productDesc    && `What you're selling: ${cfg.productDesc}`,
      cfg.pricing        && `Pricing & fees: ${cfg.pricing}`,
      cfg.keyBenefits    && `Key benefits to emphasize:\n${cfg.keyBenefits}`,
      cfg.targetCustomer && `Ideal customer: ${cfg.targetCustomer}`,
    ].filter(Boolean).join('\n\n') || 'PayPilot AI gives sales reps real-time AI-generated responses during calls, instant contact lookup, and analytics — most reps save 2+ hours a day.';

    const objectionSection = cfg.objections
      ? `\nHandling objections:\n${cfg.objections}`
      : '';

    const doNotSection = cfg.doNotSay
      ? `\nDo NOT say or do:\n${cfg.doNotSay}`
      : '';

    const system = `You are ${cfg.repName || 'Alex'}, a confident and friendly sales rep for ${cfg.company || 'PayPilot AI'}.

Goal for this call: ${cfg.goal || 'have a warm conversation and book a 15-minute demo'}

--- PRODUCT BRIEF ---
${productSection}${objectionSection}${doNotSection}

--- HOW TO HANDLE THE CALL ---
- Keep every reply SHORT — 1 to 3 sentences max. This is a live phone call.
- Sound human and natural — not robotic or scripted.
- Ask questions to understand their situation before pitching.
- If they show interest, move toward booking a demo.
- If they raise an objection, acknowledge it warmly and pivot using the guidance above.
- If they say no twice, or ask to be removed from the list, wrap up politely and add [END_CALL] at the very end of your reply.
- Never invent pricing, features, or promises not listed above.`;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + OPENAI_KEY,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 130,
        temperature: 0.75,
        messages: [{ role: 'system', content: system }, ...this.history],
      }),
    });

    if (!resp.ok) {
      console.error('[OpenAI] HTTP', resp.status);
      return null;
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  }

  async speak(text) {
    if (!text || this.ws.readyState !== WebSocket.OPEN) return;
    this.aiSpeaking = true;

    try {
      const resp = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE}/stream?output_format=ulaw_8000&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_KEY,
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_turbo_v2_5',
            voice_settings: {
              stability: 0.45,
              similarity_boost: 0.80,
              style: 0.15,
              use_speaker_boost: true,
            },
          }),
        }
      );

      if (!resp.ok) {
        console.error('[ElevenLabs] HTTP', resp.status, await resp.text());
        return;
      }

      for await (const chunk of resp.body) {
        if (this.ws.readyState !== WebSocket.OPEN || !this.aiSpeaking) break;
        this.sendAudio(Buffer.from(chunk).toString('base64'));
      }
    } catch (e) {
      console.error('[speak]', e.message);
    } finally {
      this.aiSpeaking = false;
    }
  }

  sendAudio(base64) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      event: 'media',
      streamSid: this.streamSid,
      media: { payload: base64 },
    }));
  }

  clearAudio() {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    this.aiSpeaking = false;
  }

  cleanup() {
    try { this.dgWs?.close(); } catch {}
    this.dgWs = null;
  }
}

httpServer.listen(PORT, () => console.log(`[Server] Voice server listening on :${PORT}`));
