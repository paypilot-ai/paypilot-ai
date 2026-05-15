export const config = { runtime: 'edge' };

const VOICE = 'Polly.Ruth-Neural';

function xml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sayTwiml(text) {
  return `<Say voice="${VOICE}">${xml(text)}</Say>`;
}
function b64enc(obj) {
  const str = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function gatherTwiml(say, historyB64, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=0&amp;turns=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="5" speechTimeout="auto" language="en-US">
    ${sayTwiml(say)}
  </Gather>
  <Hangup/>
</Response>`;
}

const GREETINGS = [
  'Hey, is {name} around?',
  'Hi there, can I speak with {name}?',
  'Hey, is {name} available?',
  'Hi, is {name} there?',
];

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const n = url.searchParams.get('n') || '';
    const r = url.searchParams.get('r') || '';
    const c = url.searchParams.get('c') || '';

    const template = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    const greeting = n
      ? template.replace('{name}', n)
      : 'Hey there, who am I speaking with?';

    const history = b64enc([{ role: 'assistant', content: greeting }]);
    return new Response(gatherTwiml(greeting, history, n, r, c), { headers: { 'Content-Type': 'text/xml' } });
  } catch (err) {
    console.error('ai-twiml fatal:', err?.message || err);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${VOICE}">Sorry, please try again shortly.</Say><Hangup/></Response>`,
      { status: 200, headers: { 'Content-Type': 'text/xml' } }
    );
  }
}
