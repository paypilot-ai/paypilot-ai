const { validateTwilioRequest } = require('../lib/twilioAuth');

function b64enc(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function xmlEsc(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function buildVoicemail(n, c, r, rn, s) {
  const firstName = n ? n.trim().split(/\s+/)[0] : '';
  const company = c || 'PayPilot AI';
  const reason = r ? r.slice(0, 200) : 'a quick call';
  const callback = rn
    ? `feel free to call us back at ${rn}`
    : (s ? `feel free to email us at ${s}` : `feel free to give us a call back`);
  return `Hi${firstName ? ' ' + firstName : ''}, this is Brandy calling from ${company} about ${reason}. Sorry I missed you — ${callback}, or I'll try you again soon. Thanks, have a great day!`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  try {
    if (!validateTwilioRequest(req, process.env.TWILIO_AUTH_TOKEN)) {
      console.error('[ai-twiml] rejected request with invalid/missing Twilio signature');
      return res.status(403).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`);
    }

    // Inbound calls (someone calling the Twilio number back) — Twilio marks these
    // with Direction=inbound, vs. "outbound-api" for calls we place ourselves.
    // Handled here (rather than a separate file) to stay under Vercel's function limit.
    if ((req.body && req.body.Direction) === 'inbound') {
      const forwardTo = (process.env.FORWARD_TO_NUMBER || '').trim();
      const voicemailPrompt = 'Sorry, we\'re not able to take your call right now. Please leave a message after the tone, and we\'ll get back to you.';
      if (!forwardTo) {
        return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">${xmlEsc(voicemailPrompt)}</Say><Record maxLength="120" playBeep="true" trim="trim-silence"/><Hangup/></Response>`);
      }
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20"><Number>${xmlEsc(forwardTo)}</Number></Dial><Say voice="Polly.Joanna-Neural">${xmlEsc(voicemailPrompt)}</Say><Record maxLength="120" playBeep="true" trim="trim-silence"/><Hangup/></Response>`);
    }

    const n = (req.query.n || '').trim();
    const r = (req.query.r || '').trim().slice(0, 500);
    const c = (req.query.c || '').trim();
    const e = (req.query.e || '').trim();
    const s = (req.query.s || '').trim();
    const rn = (req.query.rn || '').trim();
    const disc = (req.query.disc || '').trim().slice(0, 500);

    // Answering-machine detection (Twilio MachineDetection=Enable on the call) —
    // leave a short voicemail instead of trying to hold a live conversation.
    const answeredBy = ((req.body && req.body.AnsweredBy) || req.query.AnsweredBy || '').trim();
    if (answeredBy.startsWith('machine') || answeredBy === 'fax') {
      const voicemail = buildVoicemail(n, c, r, rn, s);
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">${xmlEsc(voicemail)}</Say><Hangup/></Response>`);
    }

    // Listen silently first — many calls are answered by an automated phone menu
    // that starts talking immediately. Speaking our greeting over it means Brandy
    // never hears (or navigates) the menu. ai-respond.js decides, once something
    // is heard (or the window times out), whether to press a digit or greet.
    const history = b64enc([]);
    const action  = `https://paypilotai.live/api/ai-respond?h=${history}&amp;intro=1&amp;iattempt=0&amp;retries=0&amp;turns=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e)}&amp;s=${encodeURIComponent(s)}`;

    // Recording-consent disclosure, spoken once up front (Compliance settings)
    // before anything else happens on the call.
    const disclosureSay = disc ? `<Say voice="Polly.Joanna-Neural">${xmlEsc(disc)}</Say>` : '';

    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${disclosureSay}
  <Gather input="speech" action="${action}" method="POST" timeout="6" speechTimeout="2" speechModel="phone_call" language="en-US" actionOnEmptyResult="true">
  </Gather>
  <Redirect method="POST">${action}</Redirect>
</Response>`);
  } catch (err) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
};
