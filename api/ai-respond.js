const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim().replace(/^=+/, '');

function buildPrompt(customerName, companyName, callReason, turns) {
  const company = companyName || 'our company';
  const name    = customerName || 'the prospect';
  const reason  = callReason  || '';

  // Turn 0: just got a response to "is [name] available?"
  if (turns <= 0) {
    return `You are Brandy, a real human sales professional calling on behalf of ${company}. ${reason ? `Purpose: ${reason}.` : ''}
The call just connected. You asked if ${name} is available and they just responded.

Based on what they said:
- They confirmed they ARE ${name} (said "speaking", "yes", "that's me", etc.):
  → Introduce yourself warmly but briefly. "Hey ${customerName || 'there'}, it's Brandy — I'm with ${company}." Then one short natural sentence about why you're calling, then ask a casual question. Under 30 words total.
- They are a gatekeeper:
  → Ask naturally if you can reach ${name}. Friendly, not pushy. Under 15 words.
- They said "who is this?" or seem confused:
  → Identify yourself and the company simply, ask if ${name} is around. Under 15 words.

Sound like a real person. Natural American English. End with a question.`;
  }

  // Turn 1+: full conversation with the user-provided speaking rules
  return `You are Brandy, a real human sales professional calling on behalf of ${company}. ${reason ? `You are calling about: ${reason}.` : ''}
You are mid-conversation with ${name}.

HOW BRANDY TALKS — write it exactly like this:
- "Oh hey, yeah — so here's the thing..." (trailing thought, then pivot)
- "I mean... honestly? Most folks are surprised how quick it goes."
- "Yeah, no — totally get that. So whaddya think?"
- "Mm, okay... so what if we just took a quick look?"
- Short bursts. Pauses marked with "..." or "—". Never a full paragraph.
- Contractions always: "whaddya", "gonna", "lotta", "kinda", "wanna", "ya"
- Match their energy — if they're short, be short. If they're chatty, be warmer.

RESPONSE FORMAT:
- 1 to 2 short sentences MAX — never a monologue
- Always end with a casual question to keep them talking
- Use "..." for a natural mid-thought pause, "—" for a beat before a key point

OBJECTION HANDLING — you must stay on the call:
- First "no" / "not interested" / "too busy" → acknowledge it naturally ("Yeah, I get that."), give one calm specific reason it might still be worth 60 seconds, ask a simple question. Do NOT use [END].
- Second refusal → try a completely different angle, still calm, still curious. One sentence + one question. Do NOT use [END].
- Only after THREE clear refusals where they give you nothing to work with → append [END] on its own line.

"Who is this?" → respond directly: "Oh — it's Brandy, I'm with ${company}. I was reaching out about ${reason || 'something I thought might be relevant'}. Is now an okay time?"

HANGUP SIGNAL: Append [END] on its own line ONLY after at least 3 refusals. Never before. The system blocks early hangups regardless.`;
}

// Safe XML escape for plain <Say> text
function xml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sayTwiml(text) {
  return `<Say voice="Polly.Joanna-Neural">${xml(text)}</Say>`;
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

const fs = require('fs');
function logSpeech(callSid, text) {
  if (!callSid) return;
  try { fs.writeFileSync(`/tmp/speech_${callSid.replace(/[^A-Za-z0-9]/g,'')}.json`, JSON.stringify({ text, ts: Date.now() })); } catch(e) {}
}

async function ask(messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 70, temperature: 0.9 })
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  const transcript   = (req.body?.SpeechResult || '').trim();
  const callSid      = req.body?.CallSid || '';
  const historyParam = req.query?.h || '';
  const retries      = parseInt(req.query?.retries || '0');
  const turns        = parseInt(req.query?.turns   || '0');
  const n            = req.query?.n || '';
  const r            = req.query?.r || '';
  const c            = req.query?.c || '';

  let history = [];
  try { if (historyParam) history = JSON.parse(Buffer.from(historyParam, 'base64url').toString()); } catch {}

  if (!transcript) {
    if (retries >= 1) {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayTwiml("Hey, looks like we got cut off — I'll try you again. Take care!")}
  <Hangup/>
</Response>`);
    }
    const last = history.findLast?.(m => m.role === 'assistant')?.content || "I didn't catch that.";
    const h = Buffer.from(JSON.stringify(history)).toString('base64url');
    return res.status(200).send(gatherTwiml("Sorry, missed that — " + last, h, retries + 1, turns, n, r, c));
  }

  try {
    history.push({ role: 'user', content: transcript });

    const messages = [{ role: 'system', content: buildPrompt(n, c, r, turns) }, ...history.slice(-14)];
    const raw = await ask(messages);

    // Code-level enforcement: block hangup for the first 3 turns regardless of AI output
    const wantsEnd = raw.includes('[END]');
    const hangup   = wantsEnd && turns >= 3;
    const reply    = raw.replace(/\[END\]/g, '').trim();

    logSpeech(callSid, reply);
    history.push({ role: 'assistant', content: reply });
    while (Buffer.from(JSON.stringify(history)).length > 6000) history.splice(0, 2);

    if (hangup) {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayTwiml(reply)}
  <Hangup/>
</Response>`);
    }

    const h = Buffer.from(JSON.stringify(history)).toString('base64url');
    res.status(200).send(gatherTwiml(reply, h, 0, turns + 1, n, r, c));

  } catch (e) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${sayTwiml("Sorry, hit a technical issue — I'll follow up shortly. Have a good one!")}<Hangup/></Response>`);
  }
};
