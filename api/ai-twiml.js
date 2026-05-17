const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim().replace(/^=+/, '');

function xml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sayTwiml(text) {
  return `<Say voice="Polly.Ruth-Neural">${xml(text)}</Say>`;
}

function gatherTwiml(say, historyB64, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=0&amp;turns=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="7" speechTimeout="auto" language="en-US">
    ${sayTwiml(say)}
  </Gather>
  <Hangup/>
</Response>`;
}

async function ask(messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 40, temperature: 0.85 })
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

const fs = require('fs');
function logSpeech(callSid, text) {
  if (!callSid) return;
  try { fs.writeFileSync(`/tmp/speech_${callSid.replace(/[^A-Za-z0-9]/g,'')}.json`, JSON.stringify({ text, ts: Date.now() })); } catch(e) {}
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  const n       = req.query?.n || '';
  const r       = req.query?.r || '';
  const c       = req.query?.c || '';
  const callSid = req.body?.CallSid || '';

  const greetingPrompt = n
    ? `Write a single short sentence asking if ${n} is available. Start with "Hi," — do NOT introduce yourself or pitch anything. Just ask for ${n} by name. Under 10 words.`
    : `Write a single short sentence asking who you're speaking with. Start with "Hi," — do NOT introduce yourself or pitch anything. Under 10 words.`;

  try {
    const greeting = await ask([
      { role: 'system', content: `You are placing a phone call. Write ONLY the spoken words — no quotes, no labels. Natural American English.` },
      { role: 'user', content: greetingPrompt }
    ]);

    logSpeech(callSid, greeting);
    const history = Buffer.from(JSON.stringify([{ role: 'assistant', content: greeting }])).toString('base64url');
    res.status(200).send(gatherTwiml(greeting, history, n, r, c));
  } catch (e) {
    const fallback = n ? `Hi, is ${n} available?` : `Hi there, who am I speaking with?`;
    const history = Buffer.from(JSON.stringify([{ role: 'assistant', content: fallback }])).toString('base64url');
    res.status(200).send(gatherTwiml(fallback, history, n, r, c));
  }
};
