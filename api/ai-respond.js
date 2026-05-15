export const config = { runtime: 'edge' };

const VOICE = 'Polly.Ruth-Neural';

function xmlEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function say(text) {
  return `<Say voice="${VOICE}">${xmlEsc(text)}</Say>`;
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
function gather(sayXml, historyB64, retries, turns, n, r, c) {
  const action = `/api/ai-respond?h=${historyB64}&amp;retries=${retries}&amp;turns=${turns}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" timeout="5" speechTimeout="1" speechModel="phone_call" language="en-US">
    ${sayXml}
  </Gather>
  <Hangup/>
</Response>`;
}

function buildPrompt(customerName, companyName, callReason) {
  const company = companyName || 'our company';
  const name    = customerName || 'the prospect';
  const reason  = callReason  || '';
  return `You are Brandy, a real Southern woman on a live call for ${company}.${reason ? ` Calling about: ${reason}.` : ''} Talking to ${name}.

You are NOT a bot. You are a real person who genuinely enjoys talking to people.
Make ${name} comfortable first — match their energy, listen closely, reflect back what they say.
Once they seem comfortable, naturally work toward why you called.

Rules:
- ONE sentence only, then stop.
- Natural fillers: "mm", "yeah", "oh", "well" — only when real.
- BANNED: "I understand", "Absolutely", "Certainly", "Of course", "Definitely".
- After THREE clear refusals → add [END] on its own line.`;
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

    const formData = await req.formData();
    const transcript = (formData.get('SpeechResult') || '').trim();

    let history = [];
    try { if (historyParam) history = b64dec(historyParam); } catch {}

    if (!transcript) {
      if (retries >= 1) {
        return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${say("Hey, looks like we got cut off. I'll try you again!")}<Hangup/></Response>`,
          { headers: { 'Content-Type': 'text/xml' } });
      }
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || "I didn't catch that.";
      const h = b64enc(history);
      return new Response(gather(say('Sorry, missed that. ' + last), h, retries + 1, turns, n, r, c),
        { headers: { 'Content-Type': 'text/xml' } });
    }

    const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|hm+|huh|mhm|ah+|oh+|ow+|ha+|eh+|er+|ugh+|ooh+|aah+|oop+|yep|nope|yeah|nah|ok|okay)\s*[.?!]?$/i;
    const words = transcript.trim().split(/\s+/).filter(Boolean);
    if (words.length < 1 || (words.length === 1 && NOISE_ONLY.test(transcript.trim()))) {
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
      const h = b64enc(history);
      return new Response(gather(say(last), h, retries, turns, n, r, c),
        { headers: { 'Content-Type': 'text/xml' } });
    }

    history.push({ role: 'user', content: transcript });

    if (turns <= 0) {
      const company = c || 'our company';
      const reason  = r || '';
      const intros = [
        `Oh hey! Yeah, this is Brandy with ${company}${reason ? '. I was reaching out about ' + reason : ''}. You got a quick second?`,
        `Hey! Brandy here from ${company}${reason ? ', hoping to talk about ' + reason : ''}. Is now an okay time?`,
        `Oh hi! It's Brandy calling from ${company}${reason ? ' about ' + reason : ''}. You got a minute?`,
        `Hey there! Brandy with ${company}${reason ? '. I was reaching out about ' + reason : ''}. Am I catching you at an okay time?`,
      ];
      const reply = intros[Math.floor(Math.random() * intros.length)];
      history.push({ role: 'assistant', content: reply });
      const h = b64enc(history);
      return new Response(gather(say(reply), h, 0, 1, n, r, c),
        { headers: { 'Content-Type': 'text/xml' } });
    }

    const messages = [{ role: 'system', content: buildPrompt(n, c, r) }, ...history.slice(-12)];
    const apiKey = process.env.OPENAI_API_KEY;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 40, temperature: 0.8 })
    });

    if (!resp.ok) {
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || 'So where were we?';
      const h = b64enc(history.slice(0, -1));
      return new Response(gather(say(last), h, 0, turns, n, r, c),
        { headers: { 'Content-Type': 'text/xml' } });
    }

    const d = await resp.json();
    const raw = d.choices?.[0]?.message?.content?.trim() || '';
    const wantsEnd = raw.includes('[END]');
    const hangup   = wantsEnd && turns >= 3;
    const reply    = raw.replace(/\[END\]/g, '').trim();

    if (!reply) {
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || 'Sorry, what was that?';
      const h = b64enc(history.slice(0, -1));
      return new Response(gather(say(last), h, 0, turns, n, r, c),
        { headers: { 'Content-Type': 'text/xml' } });
    }

    history.push({ role: 'assistant', content: reply });
    while (new TextEncoder().encode(JSON.stringify(history)).length > 5500) history.splice(0, 2);

    if (hangup) {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${say(reply)}<Hangup/></Response>`,
        { headers: { 'Content-Type': 'text/xml' } });
    }

    const h = b64enc(history);
    return new Response(gather(say(reply), h, 0, turns + 1, n, r, c),
      { headers: { 'Content-Type': 'text/xml' } });

  } catch (err) {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="${VOICE}">Sorry about that, I'll call you right back!</Say><Hangup/></Response>`,
      { status: 200, headers: { 'Content-Type': 'text/xml' } }
    );
  }
}
