// api/twilio-speak.js
// Injects AI-generated Spanish audio directly into the active Twilio call

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return res.status(500).json({ error: 'Twilio credentials not configured' });
  }

  const { callSid, text, language } = req.body || {};
  if (!callSid || !text) return res.status(400).json({ error: 'callSid and text required' });

  // Map language to TTS voice
  const voices = {
    'Spanish': 'Polly.Conchita',
    'French':  'Polly.Celine',
    'Portuguese': 'Polly.Ines',
    'English': 'Polly.Joanna'
  };
  const voice = voices[language] || 'Polly.Joanna';

  try {
    const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    // Use Twilio's Calls API to play TTS into the live call
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}" language="${language === 'Spanish' ? 'es-ES' : language === 'French' ? 'fr-FR' : language === 'Portuguese' ? 'pt-BR' : 'en-US'}">${text.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</Say>
</Response>`;

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + credentials,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          Twiml: twiml
        }).toString()
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.message || 'Twilio error' });

    return res.status(200).json({ success: true, status: data.status });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
