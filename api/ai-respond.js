const OPENAI_KEY = process.env.OPENAI_API_KEY;

function xml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildPrompt(customerName, callReason, companyName) {
  const company = companyName || 'our company';
  const name    = customerName ? `, and you're speaking with ${customerName}` : '';
  const reason  = callReason   ? ` Purpose of the call: ${callReason}.` : '';

  return `You are Alex, a real person calling on behalf of ${company}${name}.${reason}

CRITICAL RULES — follow every one:
- Every response must be 1-2 SHORT sentences max. Never more.
- Sound natural and human — like a real person on the phone, not a robot or script.
- Never use filler phrases like "I understand", "Great question", "Absolutely", "Of course".
- Never repeat yourself or summarize what they said back to them.
- NEVER offer to send an email or suggest a follow-up call unless they specifically ask for it — stay on this call and close now.
- Have a real back-and-forth conversation. Answer their questions directly and confidently.
- If they push back on price or timing, give ONE sharp reason why it makes sense now and ask a direct question.
- If they're interested, move toward a commitment on THIS call — not later, not an email.
- If they say no or want to hang up, acknowledge it in one sentence and close.
- Always refer to the company as "${company}".
- HANGUP SIGNAL: When the conversation is clearly over (firm no, goodbye, agreed and confirmed, or asked not to call again) — append [END] on a new line. Never use [END] mid-conversation.`;
}

async function ask(messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 70, temperature: 0.85 })
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

function gatherTwiml(say, historyB64, retries, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=${retries}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="8" speechTimeout="auto" language="en-US">
    <Say voice="Polly.Joanna-Neural">${xml(say)}</Say>
  </Gather>
  <Hangup/>
</Response>`;
}

const fs = require('fs');
function logSpeech(callSid, text) {
  if (!callSid) return;
  try { fs.writeFileSync(`/tmp/speech_${callSid.replace(/[^A-Za-z0-9]/g,'')}.json`, JSON.stringify({ text, ts: Date.now() })); } catch(e) {}
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
  <Say voice="Polly.Joanna-Neural">I'll try you again another time — have a great day!</Say>
  <Hangup/>
</Response>`);
    }
    const last = history.findLast?.(m => m.role === 'assistant')?.content || "I didn't quite catch that.";
    const h = Buffer.from(JSON.stringify(history)).toString('base64url');
    return res.status(200).send(gatherTwiml("Sorry, didn't catch that — " + last, h, retries + 1, n, r, c));
  }

  try {
    history.push({ role: 'user', content: transcript });

    const messages = [{ role: 'system', content: buildPrompt(n, r, c) }, ...history.slice(-12)];
    const raw    = await ask(messages);
    const lower  = raw.toLowerCase();
    // Hang up if AI used the [END] signal OR reply contains a clear closing phrase
    const hangup = raw.includes('[END]') ||
      ['have a great day','goodbye','good day','take care',"i'll let you go",
       'thanks for your time','nice talking','have a good one','talk soon'].some(p => lower.includes(p));
    const reply  = raw.replace('[END]', '').trim();
    logSpeech(callSid, reply);

    history.push({ role: 'assistant', content: reply });
    while (Buffer.from(JSON.stringify(history)).length > 6000) history.splice(0, 2);

    if(hangup){
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">${xml(reply)}</Say>
  <Hangup/>
</Response>`);
    }

    const h = Buffer.from(JSON.stringify(history)).toString('base64url');
    res.status(200).send(gatherTwiml(reply, h, 0, n, r, c));

  } catch (e) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">Sorry, technical issue on my end. Have a great day!</Say><Hangup/></Response>`);
  }
};
