const BASE_URL = 'https://paypilotai.live';

function say(text) {
  const safe = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  return `<Say voice="Polly.Joanna-Neural">${safe}</Say>`;
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
  <Gather input="speech" action="${action}" method="POST" timeout="10" speechTimeout="6" speechModel="phone_call" language="en-US">
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

function buildPrompt(customerName, companyName, callReason) {
  const company = companyName || 'our company';
  const name    = customerName || 'the prospect';
  const reason  = callReason  || 'our services';
  return `You are Brandy — a real, warm Southern woman on a live sales call for ${company}, talking to ${name} about ${reason}.

The intro is done. Do NOT say hello, hi, hey, or any greeting. Do NOT say your name again.

Reply to exactly what they just said. One short sentence — 10 words max. Stop after the period.

Tone: calm, genuine, Southern. Not peppy. Not salesy.
Banned: "I understand", "Absolutely", "Great", "Certainly", "Of course", "Definitely", "I hear you".

If they push back or say no:
— Look at the conversation history. Pick an angle you have NOT used yet.
— Second no: offer to email them details and ask if that works.
— Third no or "not interested": say a short warm goodbye, then write [END] on its own line.

If they say yes, agree, or want to move forward: close warmly in one sentence, mention the follow-up email, then write [END] on its own line.`;
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
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      }
      // Re-open the gather silently — don't replay the greeting
      const action = `/api/ai-respond?h=${b64enc(history)}&amp;retries=1&amp;turns=${turns}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e)}&amp;s=${encodeURIComponent(s)}`;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" timeout="10" speechTimeout="6" speechModel="phone_call" language="en-US">
  </Gather>
  <Hangup/>
</Response>`);
    }

    const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|hm+|huh|mhm|ah+|oh+|ow+|ha+|eh+|er+|ugh+|ooh+|aah+|oop+|yep|nope|yeah|nah|ok|okay|hello+|hey+|hi+|bye+|hm+|ew+|wow|whoa|oops|ouch)\s*[.?!]?$/i;
    const TWO_WORD_NOISE = /^(uh (huh|oh|yeah|ok|okay|hm)|oh (ok|okay|yeah|wow|right|sure|hmm)|mm (hmm|yeah|ok)|yeah (ok|okay|sure|right|hmm))[.?!]?$/i;
    const words = transcript.split(/\s+/).filter(Boolean);
    if (words.length < 1
      || (words.length === 1 && NOISE_ONLY.test(transcript))
      || (words.length === 2 && TWO_WORD_NOISE.test(transcript))) {
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
      return res.status(200).send(gather(say(last), b64enc(history), retries, turns, n, r, c, e, s));
    }

    history.push({ role: 'user', content: transcript });

    // Scripted fallback replies — used if OpenAI is slow or unavailable
    const SCRIPTED = [
      `We help with ${reason || 'outbound sales'} — want to hear more?`,
      `What's the biggest thing holding you back right now?`,
      `Can I send you a quick email with the details?`,
      `I appreciate your time — mind if I follow up?`,
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    let reply;
    try {
      const messages = [{ role: 'system', content: buildPrompt(n, c, r) }, ...history.slice(-14)];
      const apiKey = process.env.OPENAI_API_KEY;
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 30, temperature: 0.7, stop: ['\n', '. '] }),
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
          if (wantsEnd) {
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
