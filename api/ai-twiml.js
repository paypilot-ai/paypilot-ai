function b64enc(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const BASE_URL = 'https://paypilotai.live';
function ttsPlay(text) {
  return `<Play>${BASE_URL}/api/tts?text=${encodeURIComponent(text)}</Play>`;
}

const INTROS_WITH_NAME = ['Hi, may I speak with {firstName}?'];
const INTRO_NO_NAME = 'Hi there, this is Brandy calling from {company}. Who am I speaking with?';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  try {
    const n = (req.query.n || '').trim();
    const r = (req.query.r || '').trim();
    const c = (req.query.c || '').trim();
    const e = (req.query.e || '').trim();
    const s = (req.query.s || '').trim();
    const vmd = decodeURIComponent(req.query.vmd || '').trim();

    // Twilio AMD: machine detected — play voicemail drop and hang up
    const answeredBy = (req.body && req.body.AnsweredBy) || '';
    if (vmd && (answeredBy === 'machine_end_beep' || answeredBy === 'machine_end_other')) {
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  ${ttsPlay(vmd)}
  <Hangup/>
</Response>`);
    }

    const company = c || 'PayPilot AI';
    let greeting;
    if (n) {
      const firstName = n.trim().split(/\s+/)[0];
      greeting = INTROS_WITH_NAME[0].replace('{firstName}', firstName);
    } else {
      greeting = INTRO_NO_NAME.replace('{company}', company);
    }

    const history = b64enc([{ role: 'assistant', content: greeting }]);
    const action  = `https://paypilotai.live/api/ai-respond?h=${history}&amp;retries=0&amp;turns=1&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e)}&amp;s=${encodeURIComponent(s)}`;

    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" timeout="10" speechTimeout="2" speechModel="phone_call" language="en-US">
    <Pause length="1"/>
    ${ttsPlay(greeting)}
  </Gather>
  <Hangup/>
</Response>`);
  } catch (err) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
};
