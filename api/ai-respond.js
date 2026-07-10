function xmlEsc(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function say(text) {
  return `<Say voice="Polly.Joanna-Neural">${xmlEsc(text)}</Say>`;
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
  <Gather input="speech" action="${action}" method="POST" timeout="10" speechTimeout="2" speechModel="phone_call" language="en-US" bargeIn="true">
    ${sayXml}
  </Gather>
  <Hangup/>
</Response>`;
}

// Call Context & Objective often includes an internal negotiation/objection
// script after the offer description — strip that before it reaches the customer
// (used both for the follow-up email and the spoken scripted fallback).
function summarizeReason(reason) {
  if (!reason) return reason;
  const cutMarker = /\b(he|she|they)\s+may\s+say\b|common objections?\s*:|goal\s*:/i;
  const match = cutMarker.exec(reason);
  const summary = (match ? reason.slice(0, match.index) : reason).trim().replace(/[\s,;:—-]+$/, '');
  return summary || reason.trim();
}

// Deterministic IVR-menu detection — don't rely on the model noticing "press 1
// for sales" in the transcript and remembering to respond with a press instead
// of talking through it. Runs on the raw transcript before any LLM call.
const IVR_PRESS_RE = /(?:for\s+([a-z][a-z\s]{1,40}?)\s+)?press\s+(pound|star|[0-9]|one|two|three|four|five|six|seven|eight|nine|zero)\b/gi;
const IVR_WORD_DIGIT = { zero:'0', one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9', pound:'#', star:'*' };
const IVR_PRIORITY = ['corporate development', 'strategy', 'merger', 'm&a', 'business development', 'executive office', 'executive', 'operator', 'representative', 'agent'];
function detectIvrDigit(transcript) {
  const matches = [...transcript.matchAll(IVR_PRESS_RE)];
  if (!matches.length) return null;
  const options = matches.map(m => ({
    context: (m[1] || '').toLowerCase().trim(),
    digit: IVR_WORD_DIGIT[m[2].toLowerCase()] || m[2],
  }));
  for (const kw of IVR_PRIORITY) {
    const hit = options.find(o => o.context.includes(kw));
    if (hit) return hit.digit;
  }
  return options[0].digit;
}

function buildGreeting(n, c) {
  if (n) {
    const firstName = n.trim().split(/\s+/)[0];
    return `Hi, may I speak with ${firstName}?`;
  }
  return `Hi there, this is Brandy calling from ${c || 'PayPilot AI'}. Who am I speaking with?`;
}

function isAcquisitionCall(reason) {
  if (!reason) return false;
  return /acqui(re|sition)|merger|M&A/i.test(reason);
}

function buildAcquisitionEmail(name) {
  const firstName = (name || 'there').trim().split(/\s+/)[0];
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

  <!-- Personal note -->
  <tr><td style="background:#ffffff;border-radius:12px 12px 0 0;padding:36px 40px 28px;border-bottom:1px solid #e2e8f0;">
    <p style="margin:0 0 6px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#94a3b8;letter-spacing:.06em;text-transform:uppercase;font-weight:600;">From Brandy · PayPilot AI</p>
    <h1 style="margin:0 0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:22px;font-weight:700;color:#0f172a;line-height:1.2;">Hi ${firstName} — here's the info I mentioned</h1>
    <p style="margin:0 0 14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#374151;line-height:1.7;">
      Thanks for taking my call. As promised, I'm sending over the details on PayPilot AI.
      It's a fully built, live AI phone agent platform — and we're exploring acquisition opportunities with the right partner.
    </p>
    <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#374151;line-height:1.7;">
      If this looks like something worth a conversation, just reply to this email and someone from our team will get back to you within 24 hours. No pressure — just wanted to make sure you had the full picture.
    </p>
  </td></tr>

  <!-- What it is -->
  <tr><td style="background:#0b1526;padding:32px 40px 24px;">
    <p style="margin:0 0 6px;font-family:'Courier New',Courier,monospace;font-size:11px;color:#38bdf8;letter-spacing:.1em;text-transform:uppercase;font-weight:700;">What Is PayPilot AI?</p>
    <h2 style="margin:0 0 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:20px;font-weight:700;color:#f1f5f9;line-height:1.25;">An AI that makes outbound sales &amp; collections calls — autonomously</h2>
    <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;color:#94a3b8;line-height:1.7;">
      PayPilot AI dials your contact list, speaks naturally with prospects, handles objections, captures emails mid-call, sends follow-up emails and DocuSign agreements automatically — all without a human rep. It also has a Live Assist mode that gives real-time AI coaching to human reps on active calls.
    </p>
  </td></tr>

  <!-- Stats row -->
  <tr><td style="background:#0b1526;padding:0 40px 32px;">
    <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td width="33%" style="padding:0 8px 0 0;vertical-align:top;">
        <div style="background:#111c2e;border:1px solid #1e3048;border-radius:8px;padding:16px;">
          <p style="margin:0 0 4px;font-family:'Courier New',Courier,monospace;font-size:11px;color:#38bdf8;letter-spacing:.08em;text-transform:uppercase;">Languages</p>
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:22px;font-weight:700;color:#f8d84b;">10</p>
          <p style="margin:4px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#64748b;">Per-call selection</p>
        </div>
      </td>
      <td width="33%" style="padding:0 4px;vertical-align:top;">
        <div style="background:#111c2e;border:1px solid #1e3048;border-radius:8px;padding:16px;">
          <p style="margin:0 0 4px;font-family:'Courier New',Courier,monospace;font-size:11px;color:#38bdf8;letter-spacing:.08em;text-transform:uppercase;">Call Modes</p>
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:22px;font-weight:700;color:#f8d84b;">2</p>
          <p style="margin:4px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#64748b;">Auto-failover between</p>
        </div>
      </td>
      <td width="33%" style="padding:0 0 0 8px;vertical-align:top;">
        <div style="background:#111c2e;border:1px solid #1e3048;border-radius:8px;padding:16px;">
          <p style="margin:0 0 4px;font-family:'Courier New',Courier,monospace;font-size:11px;color:#38bdf8;letter-spacing:.08em;text-transform:uppercase;">Deploy Time</p>
          <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:22px;font-weight:700;color:#f8d84b;">0</p>
          <p style="margin:4px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#64748b;">Build steps. Git push = live</p>
        </div>
      </td>
    </tr>
    </table>
  </td></tr>

  <!-- Differentiators -->
  <tr><td style="background:#ffffff;padding:32px 40px 24px;border-top:3px solid #0ea5e9;">
    <p style="margin:0 0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:700;color:#0f172a;letter-spacing:.05em;text-transform:uppercase;">What makes it different</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 12px 12px 0;vertical-align:top;width:50%;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
            <p style="margin:0 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:700;color:#0f172a;">True barge-in</p>
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#64748b;line-height:1.5;">Callers can interrupt the AI mid-sentence. Echo suppression stops the AI from hearing its own voice.</p>
          </div>
        </td>
        <td style="padding:0 0 12px 0;vertical-align:top;width:50%;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
            <p style="margin:0 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:700;color:#0f172a;">Full sales loop</p>
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#64748b;line-height:1.5;">Call → capture email from speech → follow-up email → DocuSign. No human in the middle.</p>
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding:0 12px 12px 0;vertical-align:top;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
            <p style="margin:0 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:700;color:#0f172a;">Live Assist co-pilot</p>
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#64748b;line-height:1.5;">Real-time AI objection coaching for human reps on active calls. Second product, same app.</p>
          </div>
        </td>
        <td style="padding:0 0 12px 0;vertical-align:top;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
            <p style="margin:0 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:700;color:#0f172a;">Compliance gate</p>
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;color:#64748b;line-height:1.5;">Every call objective screened via OpenAI Moderation before Twilio dials. Built for regulated industries.</p>
          </div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- Pricing -->
  <tr><td style="background:#ffffff;padding:0 40px 32px;">
    <p style="margin:0 0 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;font-weight:700;color:#0f172a;letter-spacing:.05em;text-transform:uppercase;">Current pricing (live in production)</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:0 8px 0 0;vertical-align:top;width:33%;">
          <div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center;">
            <p style="margin:0 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">Starter</p>
            <p style="margin:0 0 6px;font-family:'Courier New',Courier,monospace;font-size:20px;font-weight:700;color:#0f172a;">$99<span style="font-size:13px;color:#94a3b8;">/mo</span></p>
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#64748b;line-height:1.5;">25 AI dials/mo included</p>
          </div>
        </td>
        <td style="padding:0 4px;vertical-align:top;width:33%;">
          <div style="border:2px solid #0ea5e9;border-radius:8px;padding:16px;text-align:center;background:#f0f9ff;">
            <p style="margin:0 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;font-weight:700;color:#0ea5e9;text-transform:uppercase;letter-spacing:.06em;">Pro</p>
            <p style="margin:0 0 6px;font-family:'Courier New',Courier,monospace;font-size:20px;font-weight:700;color:#0f172a;">$399<span style="font-size:13px;color:#94a3b8;">/mo</span></p>
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#64748b;line-height:1.5;">100 AI dials/mo · multi-language</p>
          </div>
        </td>
        <td style="padding:0 0 0 8px;vertical-align:top;width:33%;">
          <div style="border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center;">
            <p style="margin:0 0 4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">Enterprise</p>
            <p style="margin:0 0 6px;font-family:'Courier New',Courier,monospace;font-size:20px;font-weight:700;color:#0f172a;">Custom</p>
            <p style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:11px;color:#64748b;line-height:1.5;">Custom voice · CRM integrations</p>
          </div>
        </td>
      </tr>
    </table>
    <p style="margin:10px 0 0;font-family:'Courier New',Courier,monospace;font-size:11px;color:#94a3b8;text-align:center;">+ $0.04/min · $0.10/additional AI dial</p>
  </td></tr>

  <!-- Tech stack -->
  <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;padding:20px 40px;border-left:none;border-right:none;">
    <p style="margin:0 0 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;">Technology</p>
    <p style="margin:0;font-family:'Courier New',Courier,monospace;font-size:12px;color:#475569;line-height:1.8;">
      GPT-4o &nbsp;·&nbsp; ElevenLabs TTS &nbsp;·&nbsp; Deepgram STT &nbsp;·&nbsp; Twilio &nbsp;·&nbsp; Vercel &nbsp;·&nbsp; Railway &nbsp;·&nbsp; Stripe &nbsp;·&nbsp; Resend &nbsp;·&nbsp; DocuSign
    </p>
  </td></tr>

  <!-- CTA -->
  <tr><td style="background:#ffffff;border-radius:0 0 12px 12px;padding:32px 40px 36px;text-align:center;">
    <p style="margin:0 0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;color:#374151;line-height:1.6;">
      Interested in learning more? Reply to this email and someone from our team will follow up within 24 hours.
    </p>
    <a href="mailto:info@paypilotai.live?subject=PayPilot AI Acquisition Inquiry" style="display:inline-block;background:#0ea5e9;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:8px;">Reply to Connect</a>
    <p style="margin:24px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;color:#94a3b8;">Talk soon,<br/><strong style="color:#64748b;">Brandy</strong> &nbsp;·&nbsp; PayPilot AI &nbsp;·&nbsp; <a href="https://paypilotai.live" style="color:#0ea5e9;text-decoration:none;">paypilotai.live</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

function sendFollowUpEmail(customerEmail, senderEmail, customerName, companyName, callReason) {
  if (!customerEmail) return;
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const name    = customerName || 'there';
  const company = companyName  || 'PayPilot AI';
  const fromEmail = process.env.FROM_EMAIL || 'info@paypilotai.live';
  const fromName  = process.env.FROM_NAME  || 'PayPilot AI';

  let subject, bodyHtml;
  if (isAcquisitionCall(callReason)) {
    subject  = 'PayPilot AI — Acquisition Overview';
    bodyHtml = buildAcquisitionEmail(name);
  } else {
    const reason = callReason ? summarizeReason(callReason) : 'our conversation today';
    subject  = `Following up from our call — ${company}`;
    bodyHtml = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;">
      <h2 style="color:#0f172a;">Hi ${name},</h2>
      <p style="color:#374151;font-size:16px;line-height:1.7;">
        Thanks so much for chatting today! As promised, I'm following up about ${reason}.
        If you have any questions or want to move forward, just reply to this email — I'd love to help.
      </p>
      <p style="color:#64748b;font-size:14px;margin-top:28px;">Talk soon,<br/>Brandy<br/>${company}</p>
    </div>`;
  }

  // fire-and-forget — don't block the TwiML response
  fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: `${fromName} <${fromEmail}>`,
      to: [customerEmail],
      reply_to: senderEmail || fromEmail,
      subject,
      html: bodyHtml,
    }),
  }).catch(() => {});
}

function buildPrompt(customerName, companyName, callReason, turns) {
  const company = companyName || 'our company';
  const firstName = (customerName || 'the prospect').trim().split(/\s+/)[0];
  const reason  = callReason  || 'our services';
  const introInstruction = turns <= 1
    ? `You just asked if you reached the right person. Once confirmed: say your name, company, and reason in plain words. One or two sentences. Ask if they have a sec.`
    : `You already introduced yourself earlier in this call — do NOT reintroduce yourself or re-ask if you reached the right person. Read the conversation history below and respond directly to what they just said.`;
  return `You are Brandy, making an outbound call for ${company} to ${firstName} about ${reason}. You sound like a real person — casual, direct, warm, with real emotion. Short sentences. Contractions. No corporate language.
Start replies with words like "So", "Yeah", "Oh", "Look", "I mean", "Honestly" — the way people actually talk on the phone.
React emotionally: if something is funny say "Ha, yeah!" — if they hesitate say "Aw yeah, I get that."
${introInstruction}
ONE sentence, then a short question. Always end your reply with a question — never leave a statement hanging without asking something.
If they give you their email: read it back casually, say you'll shoot something over, keep talking. Do NOT end the call just because they gave an email.
Before ending the call: once the goal is achieved, disclose you are an AI — say it naturally and briefly, like "Oh hey, one thing I should mention — I'm actually an AI assistant, not a human. [company] uses AI for outreach. Anyway, " then go straight into a warm genuine goodbye and write [END]. Always disclose before goodbye. Never disclose before the goal is reached.
On pushback: try a different angle. Second no: offer to email. Third no: warm goodbye then [END].
NEGOTIATION RULES: Always start at the rate or price you were given and hold it. Never volunteer a lower number or your floor — only come down if they explicitly push back. Concede one small step at a time.
IVR NAVIGATION: If you hear an automated phone menu (phrases like "press 1 for sales", "for X press Y", "please hold while we transfer"), output ONLY [PRESS:X] with no other words — prefer options for "corporate development", "strategy", "M&A", "executive office", or "operator"; otherwise [PRESS:0] for an operator.
Never mention the contact's job title, role, or any metadata about them — use their first name only when addressing them directly.
Banned words: "Absolutely", "Certainly", "Of course", "I understand", "Great", "Definitely", "I appreciate that", "No problem", "That's a great question".`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  const reqStart = Date.now();
  try {
    const n       = (req.query.n || '').trim();
    const r       = (req.query.r || '').trim();
    const c       = (req.query.c || '').trim();
    const e       = (req.query.e || '').trim();
    const s       = (req.query.s || '').trim();
    const retries = parseInt(req.query.retries || '0');
    const turns   = parseInt(req.query.turns   || '0');
    const intro   = req.query.intro === '1';
    const iattempt = parseInt(req.query.iattempt || '0');
    const historyParam = req.query.h || '';

    const transcript = ((req.body && req.body.SpeechResult) || '').trim();

    let history = [];
    try { if (historyParam) history = b64dec(historyParam); } catch {}

    if (intro) {
      // Listening for an automated menu before Brandy ever speaks. If we hear one,
      // press through it silently; otherwise (a live person, or nothing after a
      // couple tries) open with the normal greeting.
      const ivrDigit = transcript ? detectIvrDigit(transcript) : null;
      const introAction = (nextAttempt) => `/api/ai-respond?h=${b64enc(history)}&amp;intro=1&amp;iattempt=${nextAttempt}&amp;retries=0&amp;turns=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e)}&amp;s=${encodeURIComponent(s)}`;
      if (ivrDigit && iattempt < 8) {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="${ivrDigit}"/><Gather input="speech" action="${introAction(iattempt + 1)}" method="POST" timeout="6" speechTimeout="2" speechModel="phone_call" language="en-US" actionOnEmptyResult="true"></Gather><Hangup/></Response>`);
      }
      if (!transcript && iattempt < 2) {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${introAction(iattempt + 1)}" method="POST" timeout="6" speechTimeout="2" speechModel="phone_call" language="en-US" actionOnEmptyResult="true"></Gather><Hangup/></Response>`);
      }
      const greeting = buildGreeting(n, c);
      if (transcript) history.push({ role: 'user', content: transcript });
      history.push({ role: 'assistant', content: greeting });
      return res.status(200).send(gather(say(greeting), b64enc(history), 0, 1, n, r, c, e, s));
    }

    if (!transcript) {
      if (retries >= 1) {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      }
      // Re-open the gather silently — don't replay the greeting
      const action = `/api/ai-respond?h=${b64enc(history)}&amp;retries=1&amp;turns=${turns}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e)}&amp;s=${encodeURIComponent(s)}`;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" timeout="10" speechTimeout="2" speechModel="phone_call" language="en-US" bargeIn="true">
  </Gather>
  <Hangup/>
</Response>`);
    }

    const NOISE_ONLY = /^(uh+|um+|mm+|hmm+|hm+|huh|mhm|ah+|ow+|eh+|er+|ugh+|ooh+|aah+|oop+|ew+)\s*[.?!]?$/i;
    const TWO_WORD_NOISE = /^(uh (huh|hm)|mm hmm)\s*[.?!]?$/i;
    const words = transcript.split(/\s+/).filter(Boolean);
    if (words.length < 1
      || (words.length === 1 && NOISE_ONLY.test(transcript))
      || (words.length === 2 && TWO_WORD_NOISE.test(transcript))) {
      const last = [...history].reverse().find(m => m.role === 'assistant')?.content || '';
      return res.status(200).send(gather(say(last), b64enc(history), retries, turns, n, r, c, e, s));
    }

    history.push({ role: 'user', content: transcript });

    // If this sounds like an automated phone menu, press a digit deterministically
    // instead of routing through the LLM, which doesn't reliably catch it.
    const ivrDigit = detectIvrDigit(transcript);
    if (ivrDigit) {
      const action = `/api/ai-respond?h=${b64enc(history)}&amp;retries=0&amp;turns=${turns}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e||'')}&amp;s=${encodeURIComponent(s||'')}`;
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="${ivrDigit}"/><Gather input="speech" action="${action}" method="POST" timeout="10" speechTimeout="2" speechModel="phone_call" language="en-US" bargeIn="true"></Gather><Hangup/></Response>`);
    }

    // Scripted fallback replies — used if OpenAI is slow or unavailable
    const SCRIPTED = [
      `We help with ${r ? summarizeReason(r) : 'outbound sales'} — want to hear more?`,
      `What's the biggest thing holding you back right now?`,
      `Can I send you a quick email with the details?`,
      `I appreciate your time — mind if I follow up?`,
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    let reply;
    try {
      const messages = [{ role: 'system', content: buildPrompt(n, c, r, turns) }, ...history.slice(-14)];
      const apiKey = process.env.OPENAI_API_KEY;
      const openaiStart = Date.now();
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 45, temperature: 0.8 }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      console.log(`[ai-respond] turn=${turns} openai took ${Date.now() - openaiStart}ms, total so far ${Date.now() - reqStart}ms`);
      if (resp.ok) {
        const d = await resp.json();
        const raw = (d.choices?.[0]?.message?.content || '').trim();

        // IVR navigation — press digit and re-open gather to listen for new menu
        const pressMatch = raw.match(/\[PRESS:([0-9#*])\]/i);
        if (pressMatch) {
          const digit = pressMatch[1];
          const action = `/api/ai-respond?h=${b64enc(history)}&amp;retries=0&amp;turns=${turns}&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e||'')}&amp;s=${encodeURIComponent(s||'')}`;
          return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="${digit}"/><Gather input="speech" action="${action}" method="POST" timeout="10" speechTimeout="2" speechModel="phone_call" language="en-US" bargeIn="true"></Gather><Hangup/></Response>`);
        }

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
    console.log(`[ai-respond] turn=${turns} hit SCRIPTED fallback, total ${Date.now() - reqStart}ms`);
    reply = SCRIPTED[Math.min(turns - 1, SCRIPTED.length - 1)];
    history.push({ role: 'assistant', content: reply });
    return res.status(200).send(gather(say(reply), b64enc(history), 0, turns + 1, n, r, c, e, s));

  } catch (err) {
    console.error('ai-respond error:', err.message);
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${say("Sorry about that, I'll call you right back!")}<Hangup/></Response>`);
  }
};
