const BASE_URL = 'https://paypilotai.live';

function say(text) {
  return `<Play>${BASE_URL}/api/tts?text=${encodeURIComponent(text)}</Play>`;
}

function b64enc(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const GREETINGS = [
  'Hey, is {name} around?',
  'Hi there, is {name} available?',
  'Hey, is {name} there?',
  'Hi, can I speak with {name}?',
];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  try {
    const n = (req.query.n || '').trim();
    const r = (req.query.r || '').trim();
    const c = (req.query.c || '').trim();

    const name = n || 'there';
    const tmpl = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    const greeting = tmpl.replace('{name}', name);

    const history = b64enc([{ role: 'assistant', content: greeting }]);
    const action = `https://paypilotai.live/api/ai-respond?h=${history}&amp;retries=0&amp;turns=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}`;

    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" timeout="7" speechTimeout="auto" speechModel="phone_call" language="en-US">
    ${say(greeting)}
  </Gather>
  <Hangup/>
</Response>`);
  } catch (e) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hi there, who am I speaking with?</Say><Hangup/></Response>`);
  }
};
