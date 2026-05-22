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
  <Gather input="speech" action="${action}" method="POST" timeout="8" speechTimeout="auto" speechModel="phone_call" language="en-US">
    ${sayXml}
  </Gather>
  <Hangup/>
</Response>`;
}

function sendFollowUpEmail(customerEmail, senderEmail, customerName, companyName, callReason) {
  if (!customerEmail) return;
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const name    = customerName || 'there';
  const company = companyName  || 'PayPilot AI';
  const reason  = callReason   || 'our conversation today';
  const fromEmail = process.env.FROM_EMAIL || 'info@paypilotai.live';
  const fromName  = process.env.FROM_NAME  || 'PayPilot AI';
  const bodyHtml = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;">
      <h2 style="color:#0f172a;">Hi ${name},</h2>
      <p style="color:#374151;font-size:16px;line-height:1.7;">
        Thanks so much for chatting today! As promised, I'm following up about ${reason}.
        If you have any questions or want to move forward, just reply to this email — I'd love to help.
      </p>
      <p style="color:#64748b;font-size:14px;margin-top:28px;">Talk soon,<br/>Brandy<br/>${company}</p>
    </div>`;
  // fire-and-forget — don't block the TwiML response
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [customerEmail],
      reply_to: senderEmail || fromEmail,
      subject: `Following up from our call — ${company}`,
      html: bodyHtml,
    }),
  }).catch(() => {});
}

function buildPrompt(customerName, companyName, callReason, history) {
  const company = companyName || 'our company';
  const name    = customerName || 'the prospect';
  const reason  = callReason  || '';

  const alreadySaid = (history || [])
    .filter(m => m.role === 'assistant')
    .map(m => `- "${m.content}"`)
    .join('\n');

  return `You are Brandy, a real Southern woman on a live call for ${company}.${reason ? ` Calling about: ${reason}.` : ''} Talking to ${name}.

You are NOT a bot. You are a real person who genuinely enjoys talking to people.
Match their energy, listen closely, respond directly to what they just said.

Rules:
- ONE sentence only, max 20 words, then stop.
- Natural fillers: "mm", "yeah", "oh", "well" — only when it fits naturally.
- BANNED words: "I understand", "Absolutely", "Certainly", "Of course", "Definitely", "Great".
- Read the conversation history. Do NOT reuse any phrasing or point you already made.
- First pushback → address their SPECIFIC concern from a brand new angle you haven't tried.
- Second pushback → offer to send info by email and ask if that's okay.
- Third clear refusal → add [END] on its own line.
- If they agree or say yes → close warmly, say you'll send a follow-up email, add [END].${alreadySaid ? `\n\nYou have already said:\n${alreadySaid}\n\nDo NOT repeat any of these points or phrases.` : ''}`;
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
      `So the reason I'm calling is ${reason || 'something I think could help you'}. Does that sound like something you'd want to hear more about?`,
      `Yeah, totally — what's the biggest thing holding you back right now?`,
      `That's fair. Would it be okay if I sent you a quick email with the details?`,
      `I appreciate your time. Mind if I follow up later this week?`,
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    let reply;
    try {
      const messages = [{ role: 'system', content: buildPrompt(n, c, r, history) }, ...history.slice(-12)];
      const apiKey = process.env.OPENAI_API_KEY;
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 35, temperature: 0.7 }),
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
            sendFollowUpEmail(e, s, n, c, r);
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
