// api/twilio-call.js
// Initiates an outbound call through Twilio and connects audio stream to Deepgram

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  const { toNumber } = req.body || {};
  if (!toNumber) return res.status(400).json({ error: 'Phone number required' });

  // Clean the number
  const cleaned = toNumber.replace(/\D/g, '');
  const e164 = cleaned.startsWith('1') ? '+' + cleaned : '+1' + cleaned;

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    
    // TwiML URL — tells Twilio what to do when call connects
    const twimlUrl = `https://paypilot-ai.vercel.app/api/twilio-twiml`;

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + credentials,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          To: e164,
          From: fromNumber,
          Url: twimlUrl,
          Record: 'true',
          RecordingStatusCallback: 'https://paypilot-ai.vercel.app/api/twilio-twiml'
        }).toString()
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.message || 'Twilio error' });

    return res.status(200).json({ 
      callSid: data.sid,
      status: data.status,
      to: e164
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
