const OPENAI_KEY = process.env.OPENAI_API_KEY;

function xml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildPrompt(customerName, callReason) {
  const base = 'You are a friendly, professional AI sales representative named Alex. ' +
    'You are warm, conversational, and natural — never robotic. Keep responses to 1-2 sentences max. ' +
    'If they seem interested, move toward scheduling a follow-up or closing. ' +
    'If they object, acknowledge it warmly and respond with a relevant benefit. Never be pushy.';
  const who  = customerName ? ` You are speaking with ${customerName}.` : '';
  const why  = callReason  ? ` The purpose of this call: ${callReason}.` : '';
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
  const n = req.query?.n || '';
  const r = req.query?.r || '';

  try {
    const prompt = buildPrompt(n, r);
    const greeting = await ask([
      { role: 'system', content: prompt },
      { role: 'user', content: 'The call just connected. Give a short warm opening greeting.' }
    ]);
    const history = Buffer.from(JSON.stringify([{ role: 'assistant', content: greeting }])).toString('base64url');
    res.status(200).send(gatherTwiml(greeting, history, 0, n, r));
  } catch (e) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, there was a technical issue.</Say><Hangup/></Response>`);
  }
};
