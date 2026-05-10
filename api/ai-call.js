// api/ai-call.js
// Triggers an AI outbound call via Twilio, pointing to the Railway voice server

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_PHONE_NUMBER: from } = process.env;
  if (!sid || !token || !from) return res.status(500).json({ error: 'Twilio not configured' });

  const { toNumber, repName, company, goal, openingLine, productDesc, pricing, keyBenefits, targetCustomer, objections, doNotSay } = req.body || {};
  if (!toNumber) return res.status(400).json({ error: 'toNumber required' });

  const digits = toNumber.replace(/\D/g, '');
  if (digits.length < 10) return res.status(400).json({ error: 'Invalid phone number' });
  const e164 = digits.startsWith('1') ? '+' + digits : '+1' + digits;

  const twimlUrl = new URL('https://paypilotai.live/api/ai-twiml');
  if (repName)        twimlUrl.searchParams.set('repName', repName);
  if (company)        twimlUrl.searchParams.set('company', company);
  if (goal)           twimlUrl.searchParams.set('goal', goal);
  if (openingLine)    twimlUrl.searchParams.set('openingLine', openingLine);
  if (productDesc)    twimlUrl.searchParams.set('productDesc', productDesc);
  if (pricing)        twimlUrl.searchParams.set('pricing', pricing);
  if (keyBenefits)    twimlUrl.searchParams.set('keyBenefits', keyBenefits);
  if (targetCustomer) twimlUrl.searchParams.set('targetCustomer', targetCustomer);
  if (objections)     twimlUrl.searchParams.set('objections', objections);
  if (doNotSay)       twimlUrl.searchParams.set('doNotSay', doNotSay);

  try {
    const creds = Buffer.from(`${sid}:${token}`).toString('base64');
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + creds,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: e164, From: from, Url: twimlUrl.toString() }).toString(),
      }
    );

    const data = await resp.json();
    if (!resp.ok) return res.status(500).json({ error: data.message || 'Twilio error' });

    return res.status(200).json({ callSid: data.sid, status: data.status, to: e164 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
