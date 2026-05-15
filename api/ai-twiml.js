const VOICE = 'Polly.Ruth-Neural';

function xml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sayTwiml(text) {
  const escaped = xml(text)
    .replace(/\.{3}/g, '<break time="400ms"/>')
    .replace(/—/g, '<break time="250ms"/>')
    .replace(/\.\s*/g, '.<break time="300ms"/> ')
    .replace(/!\s*/g,  '!<break time="250ms"/> ')
    .replace(/,\s*/g,  ',<break time="150ms"/> ');
  return `<Say voice="${VOICE}"><speak><prosody rate="92%" pitch="+3%">${escaped}</prosody></speak></Say>`;
}

function b64enc(obj) {
  const s = encodeURIComponent(JSON.stringify(obj))
    .replace(/%([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function gatherTwiml(say, historyB64, n, r, c) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="/api/ai-respond?h=${historyB64}&amp;retries=0&amp;turns=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}" method="POST" timeout="7" speechTimeout="auto" speechModel="phone_call" language="en-US">
    ${sayTwiml(say)}
  </Gather>
  <Hangup/>
</Response>`;
}

const GREETINGS = [
  'Hey, is {name} around?',
  'Hi there, is {name} available?',
  'Hey, is {name} there?',
  'Hi, can I speak with {name}?',
];

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  const n = req.query?.n || '';
  const r = req.query?.r || '';
  const c = req.query?.c || '';

  const template = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  const greeting = n
    ? template.replace('{name}', n)
    : 'Hey there, who am I speaking with?';

  const history = b64enc([{ role: 'assistant', content: greeting }]);
  res.status(200).send(gatherTwiml(greeting, history, n, r, c));
};
