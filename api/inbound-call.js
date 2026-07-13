function xmlEsc(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// Handles inbound calls to your Twilio number (e.g. a customer calling back
// after Brandy called or left a voicemail). Configure this URL as the
// "A call comes in" webhook for your number in the Twilio Console.
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  const forwardTo = (process.env.FORWARD_TO_NUMBER || '').trim();
  const voicemailPrompt = 'Sorry, we\'re not able to take your call right now. Please leave a message after the tone, and we\'ll get back to you.';

  if (!forwardTo) {
    // No forwarding number configured — go straight to voicemail.
    return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">${xmlEsc(voicemailPrompt)}</Say><Record maxLength="120" playBeep="true" trim="trim-silence"/><Hangup/></Response>`);
  }

  // Dial your real phone. If unanswered/busy/failed, <Dial> falls through to
  // the voicemail message below. Caller ID is left as the original caller's
  // number (Twilio's default) so you can see who's actually calling.
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="20"><Number>${xmlEsc(forwardTo)}</Number></Dial><Say voice="Polly.Joanna-Neural">${xmlEsc(voicemailPrompt)}</Say><Record maxLength="120" playBeep="true" trim="trim-silence"/><Hangup/></Response>`);
};
