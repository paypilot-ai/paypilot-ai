const OPENAI_KEY = process.env.OPENAI_API_KEY;

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

function gatherTwiml(say, historyB64, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="7" speechTimeout="1" language="en-US">
    ${sayTwiml(say)}
  </Gather>
  <Hangup/>
</Response>`;
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

const fs = require('fs');
function logSpeech(callSid, text) {
  if (!callSid) return;
  try { fs.writeFileSync(`/tmp/speech_${callSid.replace(/[^A-Za-z0-9]/g,'')}.json`, JSON.stringify({ text, ts: Date.now() })); } catch(e) {}
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  const n       = req.query?.n || '';   // customer name
  const r       = req.query?.r || '';   // call reason
  const c       = req.query?.c || '';   // company name
  const callSid = req.body?.CallSid || '';
  const company = c || 'our company';

  const greetingPrompt = n
    ? `Cold call opener. Alex from ${company} calling ${n}. ${r ? `About: ${r}.` : ''}
       Rules: Start "Hey ${n}," — name yourself and company in 5 words — end with a direct question (NOT "do you have a minute" or "how are you"). Under 20 words. Must end with "?".`
    : `Cold call opener. Alex from ${company}. ${r ? `About: ${r}.` : ''}
       Rules: Start "Hey," — name yourself and company in 5 words — end with a direct question (NOT "do you have a minute" or "how are you"). Under 20 words. Must end with "?".`;

  try {
    const greeting = await ask([
      {
        role: 'system',
        content: `You are Alex, a fast-talking American sales rep. Write ONLY the spoken words — no quotes, no labels, no stage directions. Sound like a real person on a phone call, not a script. American accent and tone.`
      },
      { role: 'user', content: greetingPrompt }
    ]);

    logSpeech(callSid, greeting);
    const history = Buffer.from(JSON.stringify([{ role: 'assistant', content: greeting }])).toString('base64url');
    res.status(200).send(gatherTwiml(greeting, history, n, r, c));
  } catch (e) {
    const fallback = n
      ? `Hey ${n}, this is Alex from ${company} — got a quick second?`
      : `Hey, this is Alex from ${company} — do you have a quick second?`;
    const history = Buffer.from(JSON.stringify([{ role: 'assistant', content: fallback }])).toString('base64url');
    res.status(200).send(gatherTwiml(fallback, history, n, r, c));
  }
};
