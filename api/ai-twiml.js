function b64enc(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function xmlEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const INTROS = [
  'Hey {name}! This is Brandy calling from {company}{reason}. You got a quick second?',
  'Hi {name}! Brandy here with {company}{reason}. Is now an okay time?',
  "Hey {name}! It's Brandy from {company}{reason}. Am I catching you at an okay time?",
];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  try {
    const n = (req.query.n || '').trim();
    const r = (req.query.r || '').trim();
    const c = (req.query.c || '').trim();
    const e = (req.query.e || '').trim();
    const s = (req.query.s || '').trim();

    const name    = n || 'there';
    const company = c || 'PayPilot AI';
    const reason  = r ? ` — I was reaching out about ${r}` : '';

    const tmpl    = INTROS[Math.floor(Math.random() * INTROS.length)];
    const greeting = tmpl
      .replace('{name}',    name)
      .replace('{company}', company)
      .replace('{reason}',  reason);

    const history = b64enc([{ role: 'assistant', content: greeting }]);
    const action  = `https://paypilotai.live/api/ai-respond?h=${history}&amp;retries=0&amp;turns=1&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e)}&amp;s=${encodeURIComponent(s)}`;

    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" timeout="10" speechTimeout="2" speechModel="phone_call" language="en-US">
    <Say voice="Polly.Joanna-Neural">${xmlEsc(greeting)}</Say>
  </Gather>
  <Hangup/>
</Response>`);
  } catch (err) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
};
