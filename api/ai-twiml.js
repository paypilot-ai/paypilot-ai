export const config = { runtime: 'edge' };

const VOICE = 'Polly.Ruth-Neural';

function xml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sayTwiml(text) {
  return `<Say voice="${VOICE}">${xml(text)}</Say>`;
}
function b64enc(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function gatherTwiml(say, historyB64, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=0&amp;turns=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="5" speechTimeout="1" language="en-US">
    ${sayTwiml(say)}
  </Gather>
  <Hangup/>
</Response>`;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const n = url.searchParams.get('n') || '';
  const r = url.searchParams.get('r') || '';
  const c = url.searchParams.get('c') || '';

  const apiKey = process.env.OPENAI_API_KEY;
  const greetingPrompt = n
    ? `Ask if ${n} is available. Start with "Hi," — just ask for them by name. Under 10 words.`
    : `Ask who you're speaking with. Start with "Hi," — under 10 words.`;

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 30,
        temperature: 0.7,
        messages: [
          { role: 'system', content: 'Write only the spoken words. No quotes, no labels. Natural casual English.' },
          { role: 'user', content: greetingPrompt }
        ]
      })
    });
    const d = await resp.json();
    const greeting = d.choices?.[0]?.message?.content?.trim() || (n ? `Hi, is ${n} available?` : 'Hi there, who am I speaking with?');
    const history = b64enc([{ role: 'assistant', content: greeting }]);
    return new Response(gatherTwiml(greeting, history, n, r, c), { headers: { 'Content-Type': 'text/xml' } });
  } catch {
    const fallback = n ? `Hi, is ${n} available?` : 'Hi there, who am I speaking with?';
    const history = b64enc([{ role: 'assistant', content: fallback }]);
    return new Response(gatherTwiml(fallback, history, n, r, c), { headers: { 'Content-Type': 'text/xml' } });
  }
}
