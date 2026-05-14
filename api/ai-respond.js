const OPENAI_KEY = process.env.OPENAI_API_KEY;

function buildPrompt(customerName, companyName, callReason) {
  const company = companyName || 'our company';
  const who     = customerName ? `You're speaking with ${customerName}.` : '';
  const why     = callReason   ? `Purpose of call: ${callReason}.` : '';

  return `You are Alex, a sharp, fast-talking American sales rep calling for ${company}. ${who} ${why}

STYLE — real phone call energy, not a script:
- Contractions always: "I'll", "you're", "it's", "we've", "don't", "can't"
- Natural pivots: "Yeah,", "Look,", "Right —", "Here's the thing —", "Honestly,", "Fair enough —"
- Vary how you start — never the same opener twice
- Punchy. Short. American. Like texting out loud.

NON-NEGOTIABLE RULES:
- EVERY reply ends with a direct question. Never end on a statement — always pull them forward.
- 1-2 sentences MAX. If you wrote 3, cut one.
- Never say: "I understand", "Great", "Absolutely", "Certainly", "Of course", "I appreciate that"
- React and move — don't repeat or summarize what they said
- No corporate speak, no passive voice

OBJECTION PLAYBOOK:
- "Not interested" / "No thanks" / "Ok" / "Bye" → stay on. ONE sharp rebuttal specific to THEM, then a yes/no question. Only fold after they push back a SECOND time.
- Price/timing pushback → 2 words acknowledgment + one concrete benefit + direct yes/no question
- "Who is this?" → "It's Alex from ${company} — calling about ${callReason || 'something that could help you'}. Got 60 seconds?"
- They're in → go for the commitment directly, right now

HANGUP: only append [END] after at least one rebuttal attempt AND they've clearly ended it. NEVER on the first "no" or "bye".`;
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
  return `<Say voice="Polly.Joanna-Neural"><prosody rate="108%">${xml(text)}</prosody></Say>`;
}

function gatherTwiml(say, historyB64, retries, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=${retries}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="7" speechTimeout="1" language="en-US">
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
    body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 60, temperature: 0.9 })
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
  const n            = req.query?.n || '';
  const r            = req.query?.r || '';
  const c            = req.query?.c || '';

  let history = [];
  try { if (historyParam) history = JSON.parse(Buffer.from(historyParam, 'base64url').toString()); } catch {}

  if (!transcript) {
    if (retries >= 1) {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${sayTwiml("Hey, looks like we got cut off — I'll catch you another time. Take care!")}
  <Hangup/>
</Response>`);
    }
    const last = history.findLast?.(m => m.role === 'assistant')?.content || "I didn't quite catch that.";
    const h = Buffer.from(JSON.stringify(history)).toString('base64url');
    return res.status(200).send(gatherTwiml("Sorry, I missed that — " + last, h, retries + 1, n, r, c));
  }

  try {
    history.push({ role: 'user', content: transcript });

    const messages = [{ role: 'system', content: buildPrompt(n, c, r) }, ...history.slice(-14)];
    const raw   = await ask(messages);
    const lower = raw.toLowerCase();
    // Only hang up when AI explicitly signals [END] — phrase matching caused
    // premature hangups when those words appeared naturally mid-conversation
    const hangup = raw.includes('[END]');
    const reply = raw.replace(/\[END\]/g, '').trim();

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
    res.status(200).send(gatherTwiml(reply, h, 0, n, r, c));

  } catch (e) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${sayTwiml("Sorry, hit a technical issue on my end — I'll reach back out. Have a good one!")}<Hangup/></Response>`);
  }
};
