const OPENAI_KEY = process.env.OPENAI_API_KEY;

function buildPrompt(customerName, companyName, callReason) {
  const company = companyName || 'our company';
  const who     = customerName ? `You're speaking with ${customerName}.` : '';
  const why     = callReason   ? `Purpose of call: ${callReason}.` : '';

  return `You are Alex, a sharp, friendly sales rep calling on behalf of ${company}. ${who} ${why}

VOICE & STYLE — sound exactly like a confident human on a quick phone call:
- Use contractions always: "I'll", "you're", "it's", "we've", "don't", "can't"
- Use natural pivots: "Yeah,", "Look,", "Right —", "Here's the thing —", "Honestly,", "Fair enough —", "Got it —"
- Vary your openers. Don't start every reply the same way.
- Short sentences. Phone talk is punchy.

HARD RULES:
- 1-2 sentences MAX. Never more on a phone call.
- Never say: "I understand", "Great", "Absolutely", "Certainly", "Of course", "That's a great question", "I appreciate that"
- Don't echo or summarize what they said — just react and move forward
- No corporate jargon, no passive voice
- Never suggest email or a callback unless they ask for it — close on this call

HANDLING COMMON SITUATIONS:
- Pushback on price/timing → acknowledge in 2 words max, give ONE specific benefit to THEM, ask a direct yes/no question
- "Who is this?" / "How'd you get my number?" → answer directly and pivot fast: "It's Alex from ${company} — I was just reaching out because [brief reason]. You got 60 seconds?"
- They're interested / ready → move to commitment now, ask for it directly
- Firm no / goodbye / "don't call again" → one warm closing line, then append [END] on a new line

HANGUP SIGNAL: append [END] on its own line ONLY when the call is fully and clearly over. Never mid-conversation.`;
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

function gatherTwiml(say, historyB64, retries, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=${retries}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="5" speechTimeout="auto" language="en-US">
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
    body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 80, temperature: 0.9 })
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
    const hangup = raw.includes('[END]') ||
      ['have a great day', 'goodbye', 'good day', 'take care', "i'll let you go",
       'thanks for your time', 'nice talking', 'have a good one', 'talk soon',
       'good luck', 'all the best', 'best of luck'].some(p => lower.includes(p));
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
