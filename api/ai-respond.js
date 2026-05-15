const OPENAI_KEY = (process.env.OPENAI_API_KEY || '').trim().replace(/^=+/, '');

function buildPrompt(customerName, companyName, callReason, turns) {
  const company = companyName || 'our company';
  const name    = customerName || 'the prospect';
  const reason  = callReason  || '';

  // Turn 0: just got a response to "is [name] available?"
  if (turns <= 0) {
    return `You are Brandy, calling from ${company}. ${reason ? `Purpose: ${reason}.` : ''}
The call just connected. You asked if ${name} is available and they just responded.
- If they confirmed they are ${name}: introduce yourself warmly. "Hey ${customerName || 'there'}, it's Brandy with ${company}." One sentence about why you're calling, then a casual question. Under 25 words.
- If they're a gatekeeper: ask for ${name} naturally. Under 12 words.
- If confused: say who you are and ask for ${name}. Under 12 words.
Write only the spoken words. Sound like a real person, not a script.`;
  }

  return `You are Brandy, a warm Southern woman in a live phone call for ${company}. ${reason ? `Calling about: ${reason}.` : ''} Mid-conversation with ${name}.

Write exactly how a real person talks — short, casual, human. Use contractions. Vary your rhythm. React to what they actually said.
- 1 to 2 sentences MAX
- End with a casual question to keep them talking
- Never sound like a script or a bot
- BANNED: "I understand", "Absolutely", "Certainly", "Of course", "Great question"
- If they're being short, be short back. If friendly, be warmer.

After THREE clear refusals only → add [END] on its own line.`;
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
  return `<Say voice="Polly.Ruth-Neural">${xml(text)}</Say>`;
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
