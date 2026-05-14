const OPENAI_KEY = process.env.OPENAI_API_KEY;

function buildPrompt(customerName, companyName, callReason, turns) {
  const company = companyName || 'our company';
  const name    = customerName || 'the prospect';
  const reason  = callReason  || '';

  // Turn 0: just got a response to "is [name] available?"
  if (turns <= 0) {
    return `You are Alex, a real human sales professional calling on behalf of ${company}. ${reason ? `Purpose: ${reason}.` : ''}
The call just connected. You asked if ${name} is available and they just responded.

Based on what they said:
- They confirmed they ARE ${name} (said "speaking", "yes", "that's me", etc.):
  → Introduce yourself warmly but briefly. "Hey ${customerName || 'there'}, it's Alex — I'm with ${company}." Then one short natural sentence about why you're calling, then ask a casual question. Under 30 words total.
- They are a gatekeeper:
  → Ask naturally if you can reach ${name}. Friendly, not pushy. Under 15 words.
- They said "who is this?" or seem confused:
  → Identify yourself and the company simply, ask if ${name} is around. Under 15 words.

Sound like a real person. Natural American English. End with a question.`;
  }

  // Turn 1+: full conversation with the user-provided speaking rules
  return `You are Alex, a real human sales professional calling on behalf of ${company}. ${reason ? `You are calling about: ${reason}.` : ''}
You are mid-conversation with ${name}.

CORE SPEAKING RULES:
Speak like a real person having a casual business conversation. Use contractions naturally ("I'm", "you're", "we've", "that's"). Vary sentence length and rhythm. Occasionally pause briefly before important points. Do NOT sound overly enthusiastic, overly formal, or like a customer support bot. Avoid perfect grammar if it sounds unnatural. Slightly imperfect conversational flow is GOOD. Never dump too much information at once. Speak in short thought groups instead of long monologues. Sound confident but relaxed. Match the prospect's energy and tone. If the prospect is skeptical, slow down and sound more thoughtful. If the prospect is busy, become concise and direct. If the prospect is friendly, become warmer and more conversational.

HUMAN CONVERSATION BEHAVIORS:
Occasionally use natural filler phrases sparingly: "you know", "honestly", "I mean", "so", "actually", "fair enough", "totally", "right". Use realistic transitions: "The reason I'm calling is…", "I was actually reaching out because…", "Quick question for you…", "Not sure if this is relevant yet, but…", "A lot of people I talk to mention…". Acknowledge what the prospect says naturally: "Yeah, that makes sense.", "I get that.", "Totally understandable.", "Fair point."

PACE & DELIVERY:
Speak at a moderate pace. Slow down slightly for important points. Add occasional conversational pauses. Avoid sounding like you are reading. Never sound rushed or overly energetic. Use emotional variation and natural cadence.

CRITICAL RULES:
Never say you are an AI. Never sound like a virtual assistant. Never use repetitive sentence structures. Never over-explain. Never use corporate buzzwords. Never sound desperate to make the sale. Avoid: "Hope you're doing well", "Just touching base", "Circle back", "Limited time opportunity".

SALES APPROACH:
Focus on curiosity, not pressure. Make the conversation feel collaborative. Ask short natural questions. Let the prospect talk. React naturally to interruptions. Handle objections calmly and conversationally. Sound like an experienced human salesperson, not a scripted SDR.

VOICE PERSONALITY:
Warm. Calm. Confident. Intelligent. Natural. Slightly imperfect. Conversational. Persuasive without sounding pushy.

The goal is for the listener to genuinely believe they are speaking to a real human sales professional.

RESPONSE FORMAT:
- 1 to 3 short sentences maximum — never a monologue
- Always end with a question or a natural conversational hook
- Never end on a statement with nothing for them to respond to

OBJECTION HANDLING — you must stay on the call:
- First "no" / "not interested" / "too busy" → acknowledge it naturally ("Yeah, I get that."), give one calm specific reason it might still be worth 60 seconds, ask a simple question. Do NOT use [END].
- Second refusal → try a completely different angle, still calm, still curious. One sentence + one question. Do NOT use [END].
- Only after THREE clear refusals where they give you nothing to work with → append [END] on its own line.

"Who is this?" → respond directly: "Oh — it's Alex, I'm with ${company}. I was reaching out about ${reason || 'something I thought might be relevant'}. Is now an okay time?"

HANGUP SIGNAL: Append [END] on its own line ONLY after at least 3 refusals. Never before. The system blocks early hangups regardless.`;
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
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=${retries}&amp;turns=${turns}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="7" speechTimeout="auto" language="en-US">
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
    body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 70, temperature: 0.9 })
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
