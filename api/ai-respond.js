const OPENAI_KEY = process.env.OPENAI_API_KEY;

function xml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildPrompt(customerName, callReason) {
  const base = 'You are a friendly, professional AI sales representative named Alex. ' +
    'You are warm, conversational, and natural — never robotic. Keep responses to 1-2 sentences max. ' +
    'If they seem interested, move toward scheduling a follow-up or closing. ' +
    'If they object, acknowledge it warmly and respond with a relevant benefit. Never be pushy.';
  const who = customerName ? ` You are speaking with ${customerName}.` : '';
  const why = callReason  ? ` The purpose of this call: ${callReason}.` : '';
  return base + who + why;
}

async function ask(messages) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 120 })
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

function gatherTwiml(say, historyB64, retries, n, r) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=${retries}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}" method="POST" timeout="8" speechTimeout="auto" language="en-US">
    <Say voice="Polly.Joanna-Neural">${xml(say)}</Say>
  </Gather>
  <Hangup/>
</Response>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  const transcript  = (req.body?.SpeechResult || '').trim();
  const historyParam = req.query?.h || '';
  const retries     = parseInt(req.query?.retries || '0');
  const n           = req.query?.n || '';
  const r           = req.query?.r || '';

  let history = [];
  try { if (historyParam) history = JSON.parse(Buffer.from(historyParam, 'base64url').toString()); } catch {}

  // No speech — retry once then hang up politely
  if (!transcript) {
    if (retries >= 1) {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">I wasn't able to hear you. I'll try reaching you again another time. Have a great day!</Say>
  <Hangup/>
</Response>`);
    }
    const last = history.findLast?.(m => m.role === 'assistant')?.content || "I didn't quite catch that.";
    const h = Buffer.from(JSON.stringify(history)).toString('base64url');
    return res.status(200).send(gatherTwiml("Sorry, I didn't catch that. " + last, h, retries + 1, n, r));
  }

  try {
    history.push({ role: 'user', content: transcript });

    const messages = [{ role: 'system', content: buildPrompt(n, r) }, ...history.slice(-12)];
    const reply = await ask(messages);
    history.push({ role: 'assistant', content: reply });

    while (Buffer.from(JSON.stringify(history)).length > 6000) history.splice(0, 2);

    const h = Buffer.from(JSON.stringify(history)).toString('base64url');
    res.status(200).send(gatherTwiml(reply, h, 0, n, r));

  } catch (e) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">I apologize, there was a technical issue. Have a great day!</Say><Hangup/></Response>`);
  }
};
