module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const railwayUrl = process.env.RAILWAY_URL;

  if (!railwayUrl) {
    return res.status(500).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>AI caller is not configured. Please contact support.</Say></Response>`);
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${railwayUrl}/twilio"/>
  </Connect>
</Response>`;

  return res.status(200).send(twiml);
};
