const VOICE = 'Polly.Ruth-Neural';

function xml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sayTwiml(text) {
  return `<Say voice="${VOICE}">${xml(text)}</Say>`;
}

// Must match the b64enc in ai-respond.js exactly
function b64enc(obj) {
  const s = encodeURIComponent(JSON.stringify(obj))
    .replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function gatherTwiml(say, historyB64, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=0&amp;turns=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="7" speechTimeout="auto" speechModel="phone_call" language="en-US">
    ${sayTwiml(say)}
  </Gather>
  <Hangup/>
</Response>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  const n = req.query?.n || '';
  const r = req.query?.r || '';
  const c = req.query?.c || '';

  const fallback = n ? `Hi, is ${n} available?` : `Hi there, who am I speaking with?`;

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    const prompt = n
      ? `Write one short natural sentence asking if ${n} is available to talk. Start with "Hi," — just ask for them by name, nothing else. Under 10 words.`
      : `Write one short natural sentence asking who you're speaking with. Start with "Hi," — nothing else. Under 10 words.`;

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 25, temperature: 0.7 })
    });
    const d = await resp.json();
    const greeting = d.choices?.[0]?.message?.content?.trim() || fallback;
    const history = b64enc([{ role: 'assistant', content: greeting }]);
    res.status(200).send(gatherTwiml(greeting, history, n, r, c));
  } catch (_) {
    const history = b64enc([{ role: 'assistant', content: fallback }]);
    res.status(200).send(gatherTwiml(fallback, history, n, r, c));
  }
};
