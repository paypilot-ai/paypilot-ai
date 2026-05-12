const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT ||
  'You are a friendly, professional AI sales representative named Alex. You make outbound sales calls for various clients including insurance sales, helping businesses switch from paper checks to direct deposit, and accounts payable solutions. ' +
  'You are warm, conversational, and natural — never robotic. Keep responses to 1-2 sentences max. ' +
  'Listen carefully to the prospect and address their specific situation. If they seem interested, move toward scheduling a follow-up or closing. If they object, acknowledge it warmly and respond with a relevant benefit. Never be pushy.';

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
    <Say voice="Polly.Joanna-Neural">${xml(say)}</Say>
  </Gather>
  <Redirect>/api/ai-twiml</Redirect>
</Response>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  const transcript = (req.body?.SpeechResult || '').trim();
  const historyParam = req.query?.h || '';

  let history = [];
  try { if (historyParam) history = JSON.parse(Buffer.from(historyParam, 'base64url').toString()); } catch {}

  try {
    if (!transcript) {
      // Nothing heard — ask them to repeat
      const last = history.findLast?.(m => m.role === 'assistant')?.content || "I didn't catch that, could you repeat?";
      const h = Buffer.from(JSON.stringify(history)).toString('base64url');
      return res.status(200).send(gatherTwiml(last, h));
    }

    history.push({ role: 'user', content: transcript });

    const messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...history.slice(-12)];
    const reply = await ask(messages);
    history.push({ role: 'assistant', content: reply });

    // Keep history under 6KB to stay within URL limits
    while (Buffer.from(JSON.stringify(history)).length > 6000) history.splice(0, 2);

    const h = Buffer.from(JSON.stringify(history)).toString('base64url');
    res.status(200).send(gatherTwiml(reply, h));

  } catch (e) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>I apologize, there was a technical issue. Please call back.</Say></Response>`);
  }
};
