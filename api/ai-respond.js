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
function b64dec(str) {
  return JSON.parse(atob(str.replace(/-/g,'+').replace(/_/g,'/')));
}
function gatherTwiml(say, historyB64, retries, turns, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=${retries}&amp;turns=${turns}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="5" speechTimeout="1" language="en-US">
    ${sayTwiml(say)}
  </Gather>
  <Hangup/>
</Response>`;
}

function buildPrompt(customerName, companyName, callReason, turns) {
  const company = companyName || 'our company';
  const name    = customerName || 'the prospect';
  const reason  = callReason  || '';

  if (turns <= 0) {
    return `You are Brandy, calling from ${company}. ${reason ? `Purpose: ${reason}.` : ''}
The call just connected. You just asked if ${name} is available and they responded.
- If they confirmed they are ${name}: say "Hey ${customerName || 'there'}, it's Brandy with ${company}." then one short sentence about why you're calling and a casual question. Under 25 words total.
- If gatekeeper: ask for ${name} naturally. Under 12 words.
- If confused: say who you are, ask for ${name}. Under 12 words.
Write only the spoken words.`;
  }

  return `You are Brandy, a warm Southern woman on a live call for ${company}. ${reason ? `Calling about: ${reason}.` : ''} Talking to ${name}.
Write the way real people talk — words running together naturally, easy rhythm. Use natural fillers like "mm", "yeah", "well", "you know" when it fits — keeps it human.
- 1 to 2 sentences MAX, one flowing thought
- End with a casual question
- Never sound scripted
- BANNED: "I understand", "Absolutely", "Certainly", "Of course", "Great question"
After THREE clear refusals only → add [END] on its own line.`;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const n       = url.searchParams.get('n') || '';
  const r       = url.searchParams.get('r') || '';
  const c       = url.searchParams.get('c') || '';
  const retries = parseInt(url.searchParams.get('retries') || '0');
  const turns   = parseInt(url.searchParams.get('turns')   || '0');
  const historyParam = url.searchParams.get('h') || '';

  const formData  = await req.formData();
  const transcript = (formData.get('SpeechResult') || '').trim();

  let history = [];
  try { if (historyParam) history = b64dec(historyParam); } catch {}

  if (!transcript) {
    if (retries >= 1) {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${sayTwiml("Hey, looks like we got cut off — I'll try you again. Take care!")}<Hangup/></Response>`,
        { headers: { 'Content-Type': 'text/xml' } });
    }
    const last = [...history].reverse().find(m => m.role === 'assistant')?.content || "I didn't catch that.";
    const h = b64enc(history);
    return new Response(gatherTwiml('Sorry, missed that — ' + last, h, retries + 1, turns, n, r, c),
      { headers: { 'Content-Type': 'text/xml' } });
  }

  try {
    history.push({ role: 'user', content: transcript });
    const messages = [{ role: 'system', content: buildPrompt(n, c, r, turns) }, ...history.slice(-12)];

    const apiKey = process.env.OPENAI_API_KEY;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 60, temperature: 0.8 })
    });
    const d = await resp.json();
    const raw   = d.choices?.[0]?.message?.content?.trim() || '';
    const wantsEnd = raw.includes('[END]');
    const hangup   = wantsEnd && turns >= 3;
    const reply    = raw.replace(/\[END\]/g, '').trim();

    history.push({ role: 'assistant', content: reply });
    // trim history if too large
    while (new TextEncoder().encode(JSON.stringify(history)).length > 5500) history.splice(0, 2);

    if (hangup) {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${sayTwiml(reply)}<Hangup/></Response>`,
        { headers: { 'Content-Type': 'text/xml' } });
    }

    const h = b64enc(history);
    return new Response(gatherTwiml(reply, h, 0, turns + 1, n, r, c),
      { headers: { 'Content-Type': 'text/xml' } });

  } catch {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${sayTwiml("Sorry, hit a snag — I'll follow up shortly. Have a good one!")}<Hangup/></Response>`,
      { headers: { 'Content-Type': 'text/xml' } });
  }
}
