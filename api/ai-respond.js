const OPENAI_KEY = process.env.OPENAI_API_KEY;

function buildPrompt(customerName, companyName, callReason, turns) {
  const company = companyName || 'our company';
  const name    = customerName || 'the prospect';
  const reason  = callReason  || '';

  // Turn 0: just got a response to "is [name] available?"
  if (turns <= 0) {
    return `You are Alex, calling on behalf of ${company}. ${reason ? `Purpose: ${reason}.` : ''}
The call just started. You asked if ${name} is available and the person responded.

DO THIS based on what they said:
- They said "speaking", "yes", "this is them", or confirmed they ARE ${name}:
  → Introduce yourself: "Hey ${customerName ? customerName + ',' : ','} it's Alex with ${company} —" then ONE punchy sentence about ${reason || 'why you\'re calling'}, then a direct question. Under 25 words total.
- They are a gatekeeper (someone else answered):
  → Politely ask to be connected to ${name}: "Oh hey, is ${name} around by any chance?" Under 15 words.
- They said "who is this?" or seem confused:
  → "It's Alex with ${company} — is ${name} available?" Under 12 words.

American, natural, no corporate speak. End with a question.`;
  }

  // Turn 1+: normal conversation
  return `You are Alex, a sharp, natural-sounding American sales rep calling for ${company}. ${reason ? `Call purpose: ${reason}.` : ''}
You're mid-conversation with ${name}.

STYLE — real phone call, not a script:
- Short sentences. Contractions always. American English.
- Natural pivots: "Yeah,", "Look,", "Right —", "Here's the thing —", "Honestly,", "Fair enough —"
- Never start two replies the same way

NON-NEGOTIABLE:
- 1-2 sentences MAX — punchy, not a speech
- ALWAYS end with a direct question — never a statement
- Never say: "I understand", "Great", "Absolutely", "Certainly", "Of course"

OBJECTION HANDLING — MANDATORY rebuttals:
- First "no" / "not interested" / "ok bye" → give ONE sharp rebuttal about a real benefit to THEM, ask a yes/no question. DO NOT use [END].
- Second refusal → give a SECOND rebuttal, different angle, ask one more question. DO NOT use [END].
- Only after THREE clear refusals with no engagement → append [END]

"Who is this?" → "It's Alex with ${company} — calling about ${reason || 'something quick'}. You got 60 seconds?"

HANGUP: Append [END] on its own line ONLY after 3 clear refusals. NEVER before that.`;
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
  return `<Say voice="Google.en-US-Neural2-F">${xml(text)}</Say>`;
}

function gatherTwiml(say, historyB64, retries, turns, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=${retries}&amp;turns=${turns}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="7" speechTimeout="1" language="en-US">
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
    body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 70, temperature: 0.9 })
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
