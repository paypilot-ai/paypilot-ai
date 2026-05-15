export const config = { runtime: 'edge' };

const VOICE = 'Polly.Ruth-Neural';

function xml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sayTwiml(text) {
  return `<Say voice="${VOICE}">${xml(text)}</Say>`;
}
function b64enc(obj) {
  const s = encodeURIComponent(JSON.stringify(obj))
    .replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function b64dec(str) {
  let s = str.replace(/-/g,'+').replace(/_/g,'/');
  s += '===='.slice(0, (4 - s.length % 4) % 4);
  return JSON.parse(decodeURIComponent(
    atob(s).replace(/[\x80-\xFF]/g, c => '%' + ('0' + c.charCodeAt(0).toString(16)).slice(-2).toUpperCase())
  ));
}
function gatherTwiml(say, historyB64, retries, turns, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=${retries}&amp;turns=${turns}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="5" speechTimeout="0.5" speechModel="phone_call" language="en-US">
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
    // Skip OpenAI entirely for the intro — return a hardcoded signal
    return '__INTRO__';
  }

  return `You are Brandy, a warm Southern woman on a live sales call for ${company}. ${reason ? `Calling about: ${reason}.` : ''} Talking to ${name}.
Talk like a real person — short, natural, reactive. Say ONE thing then stop and let them respond. Never monologue.
React to exactly what they said. Use fillers: "yeah", "mm", "oh" when natural. Match their energy.
- ONE sentence only. Stop there. Let them talk.
- End with a short question.
- BANNED: "I understand", "Absolutely", "Certainly", "Of course", "Great question"
After THREE clear refusals only → add [END] on its own line.`;
}

export default async function handler(req) {
  try {
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

    // Filter noise — ignore filler sounds and very short non-words
    const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|hm+|huh|mhm|ah+|oh+|ow+|ha+|eh+|er+|ugh+|ooh+|aah+|oop+|yep|nope|yeah|nah|ok|okay)\s*[.?!]?$/i;
    const words = transcript.trim().split(/\s+/).filter(Boolean);
    if (words.length < 1 || (words.length === 1 && NOISE_ONLY.test(transcript.trim()))) {
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
      const h = b64enc(history);
      return new Response(gatherTwiml(last, h, retries, turns, n, r, c),
        { headers: { 'Content-Type': 'text/xml' } });
    }

    history.push({ role: 'user', content: transcript });

    // Turn 0 intro — skip OpenAI, respond instantly
    if (turns <= 0) {
      const company = c || 'our company';
      const reason  = r || '';
      const intros = [
        `Oh hey! Yeah, this is Brandy with ${company}${reason ? ', reaching out about ' + reason : ''}. You got a quick second?`,
        `Hey! Yeah, Brandy here calling from ${company}${reason ? ', I was hoping to talk about ' + reason : ''}. Is now an okay time?`,
        `Oh hi! Yeah, it's Brandy with ${company}${reason ? ', calling about ' + reason : ''}. You got a minute?`,
      ];
      const reply = intros[Math.floor(Math.random() * intros.length)];
      history.push({ role: 'assistant', content: reply });
      const h = b64enc(history);
      return new Response(gatherTwiml(reply, h, 0, 1, n, r, c),
        { headers: { 'Content-Type': 'text/xml' } });
    }

    const messages = [{ role: 'system', content: buildPrompt(n, c, r, turns) }, ...history.slice(-12)];

    const apiKey = process.env.OPENAI_API_KEY;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 30, temperature: 0.8 })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('OpenAI error', resp.status, errText);
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || "So where were we?";
      const h = b64enc(history.slice(0, -1));
      return new Response(gatherTwiml(last, h, 0, turns, n, r, c),
        { headers: { 'Content-Type': 'text/xml' } });
    }

    const d = await resp.json();
    const raw   = d.choices?.[0]?.message?.content?.trim() || '';
    const wantsEnd = raw.includes('[END]');
    const hangup   = wantsEnd && turns >= 3;
    const reply    = raw.replace(/\[END\]/g, '').trim();

    if (!reply) {
      console.error('Empty reply from OpenAI', JSON.stringify(d));
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || "Sorry, what was that?";
      const h = b64enc(history.slice(0, -1));
      return new Response(gatherTwiml(last, h, 0, turns, n, r, c),
        { headers: { 'Content-Type': 'text/xml' } });
    }

    history.push({ role: 'assistant', content: reply });
    while (new TextEncoder().encode(JSON.stringify(history)).length > 5500) history.splice(0, 2);

    if (hangup) {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${sayTwiml(reply)}<Hangup/></Response>`,
        { headers: { 'Content-Type': 'text/xml' } });
    }

    const h = b64enc(history);
    return new Response(gatherTwiml(reply, h, 0, turns + 1, n, r, c),
      { headers: { 'Content-Type': 'text/xml' } });

  } catch (err) {
    console.error('ai-respond fatal:', err?.message || err);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${VOICE}">Sorry about that, let me call you right back!</Say><Hangup/></Response>`,
      { status: 200, headers: { 'Content-Type': 'text/xml' } }
    );
  }
}
