const OPENAI_KEY   = process.env.OPENAI_API_KEY;
const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  'You are a professional AI collections agent. Be concise — respond in 1-2 sentences. Your goal is to collect payment or arrange a payment plan. Be polite and compliant.';

function xml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

function gatherTwiml(say, historyB64) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}" method="POST" timeout="8" speechTimeout="auto" language="en-US">
    <Say voice="Polly.Joanna">${xml(say)}</Say>
  </Gather>
  <Redirect>/api/ai-twiml</Redirect>
</Response>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  try {
    const greeting = await ask([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: 'The call just connected. Give a short professional opening greeting.' }
    ]);
    const history = Buffer.from(JSON.stringify([{ role: 'assistant', content: greeting }])).toString('base64url');
    res.status(200).send(gatherTwiml(greeting, history));
  } catch (e) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, there was a technical issue.</Say></Response>`);
  }
};
