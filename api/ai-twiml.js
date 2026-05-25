const BASE_URL = 'https://paypilotai.live';

function b64enc(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  try {
    const n = (req.query.n || '').trim();
    const r = (req.query.r || '').trim();
    const c = (req.query.c || '').trim();
    const e = (req.query.e || '').trim();
    const s = (req.query.s || '').trim();

    let greeting;
    if (n) {
      const firstName = n.trim().split(/\s+/)[0];
      greeting = `Hi, may I speak with ${firstName}?`;
    } else {
      const company = c || 'PayPilot AI';
      greeting = `Hi there, this is Brandy calling from ${company}. Who am I speaking with?`;
    }

    const history = b64enc([{ role: 'assistant', content: greeting }]);
    const action  = `https://paypilotai.live/api/ai-respond?h=${history}&amp;retries=0&amp;turns=1&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e)}&amp;s=${encodeURIComponent(s)}`;

    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Gather input="speech" action="${action}" method="POST" timeout="10" speechTimeout="6" speechModel="phone_call" language="en-US">
    <Play>${BASE_URL}/api/tts?text=${encodeURIComponent(greeting)}</Play>
  </Gather>
  <Hangup/>
</Response>`);
  } catch (err) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
};
