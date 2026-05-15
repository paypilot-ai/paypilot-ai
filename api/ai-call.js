module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken  = (process.env.TWILIO_AUTH_TOKEN  || '').trim();
  const fromNumber = (process.env.TWILIO_PHONE_NUMBER || '').trim();

  if (!accountSid || !authToken || !fromNumber) {
    return res.status(500).json({
      error: 'Twilio credentials not configured',
      has_sid: !!accountSid,
      has_token: !!authToken,
      has_number: !!fromNumber,
      sid_preview: accountSid ? accountSid.slice(0,6) + '...' : 'MISSING',
      number_preview: fromNumber || 'MISSING'
    });
  }

  const { toNumber, customerName, callReason, companyName } = req.body || {};
  if (!toNumber) return res.status(400).json({ error: 'Phone number required' });

  const cleaned = toNumber.replace(/\D/g, '');
  const e164 = cleaned.startsWith('1') ? '+' + cleaned : '+1' + cleaned;

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    // Build greeting inline — no round-trip to ai-twiml.js
    const n = customerName || '';
    const r = callReason   || '';
    const c = companyName  || '';
    const greetings = [
      n ? `Hey, is ${n} around?`         : 'Hey there, who am I speaking with?',
      n ? `Hi there, can I speak with ${n}?` : 'Hi, who am I speaking with?',
      n ? `Hey, is ${n} available?`      : 'Hi there, who am I speaking with?',
      n ? `Hi, is ${n} there?`           : 'Hey, who do I have the pleasure of speaking with?',
    ];
    const greeting = greetings[Math.floor(Math.random() * greetings.length)];
    const history  = Buffer.from(JSON.stringify([{ role: 'assistant', content: greeting }])).toString('base64')
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');

    const actionUrl = `https://paypilot-ai.vercel.app/api/ai-respond?h=${history}&retries=0&turns=0`
      + `&n=${encodeURIComponent(n)}&r=${encodeURIComponent(r)}&c=${encodeURIComponent(c)}`;

    function xmlEsc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${actionUrl}" method="POST" timeout="5" speechTimeout="auto" language="en-US"><Say voice="Polly.Ruth-Neural">${xmlEsc(greeting)}</Say></Gather><Hangup/></Response>`;

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: { 'Authorization': 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: e164, From: fromNumber, Twiml: twiml }).toString()
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(500).json({
      error: `Twilio ${data.status || response.status}: ${data.message || 'unknown error'} (code ${data.code || 'none'})`,
      sid_used: accountSid.slice(0,6) + '...' + accountSid.slice(-4),
      sid_length: accountSid.length
    });

    return res.status(200).json({ callSid: data.sid, status: data.status, to: e164 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
