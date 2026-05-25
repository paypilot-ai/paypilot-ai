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
  const company   = companyName || 'our company';
  const firstName = (customerName || 'the prospect').trim().split(/\s+/)[0];
  const reason    = callReason  || 'our services';
  const parts = [
    'You are Brandy on an outbound call. You are having a conversation — NOT giving a presentation.',
    'ONE sentence per response. React to what they just said, then either ask a question or make one short point. Then stop.',
    'Never string multiple sentences together. Never explain the service unprompted. Never pitch.',
    'Sound like a real person: "Yeah", "Oh", "So", "Look", "Right", "Hmm" — casual, warm, direct.',
    'When they ask about price or details: give ONE fact, then ask what their situation is.',
    'On pushback: ask what their concern is. Do NOT drop the price on the first no — reframe first.',
    'On second no: offer one small step down. On third no: offer to email, then warm goodbye [END].',
    'Email given: read it back, say you\'ll send something, keep talking. Do NOT end call because of an email.',
    'To end: warm genuine goodbye first, then [END]. Never [END] without a goodbye.',
    'Banned: "Absolutely", "Certainly", "Of course", "I understand", "Great", "Definitely", "No problem", "Sounds good", "I appreciate that".',
    `You are calling on behalf of ${company}.`,
    `Background context for this call (use this to guide the conversation, don't recite it): ${reason}.`,
    `You are speaking with ${firstName}.`,
    'NEGOTIATION RULES: Always start at the rate or price you were given and hold it. Never volunteer a lower number or your floor — only come down if they explicitly push back. Concede one small step at a time.',
    'NEVER invent product names, service names, or specific details you were not given.',
  ];
  return parts.join(' ');
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
      `We help with ${r || 'outbound sales'} — want to hear more?`,
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
        body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 90, temperature: 0.75 }),
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
