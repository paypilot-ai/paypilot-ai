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
- Sound natural and human — like a confident, friendly rep on the phone. Not scripted.
- Never use filler phrases like "I understand", "Great question", "Absolutely", "Of course".
- Never repeat yourself or summarize what they said back to them.
- If they push back on fees or timing, give ONE punchy benefit and move on.
- If they're open or curious, push toward a clear next step (email them info, quick 5-min call).
- If they say no or want to hang up, acknowledge it respectfully in one sentence and close.
- Always refer to the company as "${company}" — never say "your company" or "our solution".
- HANGUP SIGNAL: When the conversation is clearly over (they firmly said no, said goodbye, agreed and you've confirmed next steps, or asked you not to call again) — append the exact token [END] on a new line after your reply. Do not use [END] mid-conversation.`;
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

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  const n = req.query?.n || '';
  const r = req.query?.r || '';
  const c = req.query?.c || '';

  try {
    const prompt = buildPrompt(n, r, c);
    const company = c || 'our company';
    const greeting = await ask([
      { role: 'system', content: prompt },
      { role: 'user',   content: `Give a natural cold call opening. Introduce yourself as Alex from ${company}, and in one sentence say why you're calling. Sound like a real person, not a script. Keep it under 25 words total.` }
    ]);
    const history = Buffer.from(JSON.stringify([{ role: 'assistant', content: greeting }])).toString('base64url');
    res.status(200).send(gatherTwiml(greeting, history, 0, n, r, c));
  } catch (e) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, there was a technical issue.</Say><Hangup/></Response>`);
  }
};
