function b64enc(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  try {
    const n = (req.query.n || '').trim();
    const r = (req.query.r || '').trim().slice(0, 500);
    const c = (req.query.c || '').trim();
    const e = (req.query.e || '').trim();
    const s = (req.query.s || '').trim();

    // Listen silently first — many calls are answered by an automated phone menu
    // that starts talking immediately. Speaking our greeting over it means Brandy
    // never hears (or navigates) the menu. ai-respond.js decides, once something
    // is heard (or the window times out), whether to press a digit or greet.
    const history = b64enc([]);
    const action  = `https://paypilotai.live/api/ai-respond?h=${history}&amp;intro=1&amp;iattempt=0&amp;retries=0&amp;turns=0&amp;n=${encodeURIComponent(n)}&amp;r=${encodeURIComponent(r)}&amp;c=${encodeURIComponent(c)}&amp;e=${encodeURIComponent(e)}&amp;s=${encodeURIComponent(s)}`;

    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${action}" method="POST" timeout="6" speechTimeout="2" speechModel="phone_call" language="en-US" actionOnEmptyResult="true">
  </Gather>
  <Redirect method="POST">${action}</Redirect>
</Response>`);
  } catch (err) {
    res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
};
