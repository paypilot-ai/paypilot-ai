// api/ai-twiml.js
// Returns TwiML that connects Twilio to the Railway WebSocket voice server

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  const wsUrl = process.env.VOICE_SERVER_URL || 'wss://paypilot-voice.up.railway.app';

  const params = Object.entries(req.query || {})
    .map(([k, v]) => `      <Parameter name="${xmlEscape(k)}" value="${xmlEscape(v)}"/>`)
    .join('\n');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(wsUrl)}">
${params}
    </Stream>
  </Connect>
</Response>`;

  return res.status(200).send(twiml);
};
