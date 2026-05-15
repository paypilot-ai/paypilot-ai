const VOICE = 'Polly.Ruth-Neural';

function xmlEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function say(text) {
  const escaped = xmlEsc(text)
    .replace(/\.{3}/g, '<break time="500ms"/>')
    .replace(/—/g, '<break time="300ms"/>')
    .replace(/\.(?=\s|$)/g, '.<break time="400ms"/>')
    .replace(/!(?=\s|$)/g,  '!<break time="300ms"/>')
    .replace(/,(?=\s)/g,    ',<break time="200ms"/>');
  return `<Say voice="${VOICE}"><prosody rate="90%" pitch="+4%">${escaped}</prosody></Say>`;
}
function b64enc(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function gatherTwiml(sayXml, historyB64, n, r, c) {
  const action = `/api/ai-respond?h=${historyB64}&amp;retries=0&amp;turns=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" timeout="7" speechTimeout="auto" speechModel="phone_call" language="en-US">
    ${sayXml}
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
  const greeting = n ? template.replace('{name}', xmlEsc(n)) : 'Hey there, who am I speaking with?';

  const history = b64enc([{ role: 'assistant', content: greeting }]);
  res.status(200).send(gatherTwiml(say(greeting), history, n, r, c));
};
