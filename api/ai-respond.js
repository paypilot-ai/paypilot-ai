const BASE_URL = 'https://paypilotai.live';

function say(text) {
  return `<Play>${BASE_URL}/api/tts?text=${encodeURIComponent(text)}</Play>`;
}
function b64enc(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function b64dec(str) {
  let s = str.replace(/-/g,'+').replace(/_/g,'/');
  s += '===='.slice(0, (4 - s.length % 4) % 4);
  return JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
}
function gather(sayXml, historyB64, retries, turns, n, r, c, e, s) {
  const action = `/api/ai-respond?h=${historyB64}&amp;retries=${retries}&amp;turns=${turns}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e||'')}&amp;s=${encodeURIComponent(s||'')}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" timeout="5" speechTimeout="1" speechModel="phone_call" language="en-US">
    ${sayXml}
  </Gather>
  <Hangup/>
</Response>`;
}

async function sendFollowUpEmail(customerEmail, senderEmail, customerName, companyName, callReason) {
  if (!customerEmail) return;
  try {
    const name = customerName || 'there';
    const company = companyName || 'your company';
    const reason = callReason || 'the conversation we just had';
    const message = `Hi ${name},\n\nThanks so much for taking the time to chat today! As promised, I'm sending over some info about ${reason}.\n\nIf you have any questions or want to move forward, just reply to this email — I'd love to help.\n\nTalk soon,\nBrandy\n${company}`;
    await fetch(`${BASE_URL}/api/send-agreement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: name,
        customerEmail,
        senderEmail: senderEmail || 'info@paypilotai.live',
        subject: `Following up from our call — ${company}`,
        message,
      }),
    });
  } catch (_) {}
}

function buildPrompt(customerName, companyName, callReason) {
  const company = companyName || 'our company';
  const name    = customerName || 'the prospect';
  const reason  = callReason  || '';
  return `You are Brandy, a real Southern woman on a live call for ${company}.${reason ? ` Calling about: ${reason}.` : ''} Talking to ${name}.

You are NOT a bot. You are a real person who genuinely enjoys talking to people.
Make ${name} comfortable first — match their energy, listen closely.
Once they seem comfortable, naturally work toward why you called.

Rules:
- ONE sentence only, then stop.
- Natural fillers: "mm", "yeah", "oh", "well" — only when real.
- BANNED: "I understand", "Absolutely", "Certainly", "Of course", "Definitely".
- NEVER repeat the same pitch or benefit you already said. Each response must use a NEW angle.
- First pushback → acknowledge their concern genuinely, then address it from a completely different angle.
- Second pushback → shift to "let me send you some info" and offer a soft close.
- Third clear refusal → add [END] on its own line.
- If they agree or say yes → wrap up warmly, mention you'll send them a follow-up email, then add [END].`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  try {
    const n       = (req.query.n || '').trim();
    const r       = (req.query.r || '').trim();
    const c       = (req.query.c || '').trim();
    const e       = (req.query.e || '').trim();
    const s       = (req.query.s || '').trim();
    const retries = parseInt(req.query.retries || '0');
    const turns   = parseInt(req.query.turns   || '0');
    const historyParam = req.query.h || '';

    const transcript = ((req.body && req.body.SpeechResult) || '').trim();

    let history = [];
    try { if (historyParam) history = b64dec(historyParam); } catch {}

    if (!transcript) {
      if (retries >= 1) {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${say("Hey, looks like we got cut off. I'll try you again!")}<Hangup/></Response>`);
      }
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || "I didn't catch that.";
      return res.status(200).send(gather(say('Sorry, missed that — ' + last), b64enc(history), retries + 1, turns, n, r, c, e, s));
    }

    const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|hm+|huh|mhm|ah+|oh+|ow+|ha+|eh+|er+|ugh+|ooh+|aah+|oop+|yep|nope|yeah|nah|ok|okay)\s*[.?!]?$/i;
    const words = transcript.split(/\s+/).filter(Boolean);
    if (words.length < 1 || (words.length === 1 && NOISE_ONLY.test(transcript))) {
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
      return res.status(200).send(gather(say(last), b64enc(history), retries, turns, n, r, c, e, s));
    }

    history.push({ role: 'user', content: transcript });

    const company = c || 'our company';
    const reason  = r || '';

    if (turns <= 0) {
      const intros = [
        `Oh hey! Yeah, this is Brandy with ${company}${reason ? '. I was reaching out about ' + reason : ''}. You got a quick second?`,
        `Hey! Brandy here from ${company}${reason ? ', hoping to talk about ' + reason : ''}. Is now an okay time?`,
        `Oh hi! It's Brandy calling from ${company}${reason ? ' about ' + reason : ''}. You got a minute?`,
        `Hey there! Brandy with ${company}${reason ? '. I was reaching out about ' + reason : ''}. Am I catching you at an okay time?`,
      ];
      const reply = intros[Math.floor(Math.random() * intros.length)];
      history.push({ role: 'assistant', content: reply });
      return res.status(200).send(gather(say(reply), b64enc(history), 0, 1, n, r, c, e, s));
    }

    // Scripted fallback replies — used if OpenAI is slow or unavailable
    const SCRIPTED = [
      `Oh yeah, absolutely — so the reason I was reaching out is about ${reason || 'some great options we have'}. Does that sound like something you'd be open to?`,
      `Mm, yeah — I totally get that. What would be the best time to talk about this more?`,
      `Oh interesting, tell me more about that.`,
      `Right, right — well, I appreciate your time. Can I follow up with you later this week?`,
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    let reply;
    try {
      const messages = [{ role: 'system', content: buildPrompt(n, c, r) }, ...history.slice(-12)];
      const apiKey = process.env.OPENAI_API_KEY;
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 40, temperature: 0.8 }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (resp.ok) {
        const d = await resp.json();
        const raw = (d.choices?.[0]?.message?.content || '').trim();
        const wantsEnd = raw.includes('[END]');
        reply = raw.replace(/\[END\]/g, '').trim();
        if (reply) {
          history.push({ role: 'assistant', content: reply });
          while (Buffer.byteLength(JSON.stringify(history)) > 5500) history.splice(0, 2);
          if (wantsEnd && turns >= 3) {
            await sendFollowUpEmail(e, s, n, c, r);
            return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${say(reply)}<Hangup/></Response>`);
          }
          return res.status(200).send(gather(say(reply), b64enc(history), 0, turns + 1, n, r, c, e, s));
        }
      }
    } catch (_) {
      clearTimeout(timeout);
    }

    // Fallback to scripted reply if OpenAI failed or timed out
    reply = SCRIPTED[Math.min(turns - 1, SCRIPTED.length - 1)];
    history.push({ role: 'assistant', content: reply });
    return res.status(200).send(gather(say(reply), b64enc(history), 0, turns + 1, n, r, c, e, s));

  } catch (err) {
    console.error('ai-respond error:', err.message);
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${say("Sorry about that, I'll call you right back!")}<Hangup/></Response>`);
  }
};
