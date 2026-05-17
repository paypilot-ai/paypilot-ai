const VOICE = 'Polly.Ruth-Neural';

function xmlEsc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function say(text) {
  return `<Say voice="${VOICE}">${xmlEsc(text)}</Say>`;
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
  // Minimal test — proves Twilio can reach this endpoint
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">Hello, this is Pay Pilot. The system is working.</Say><Hangup/></Response>`);
};
