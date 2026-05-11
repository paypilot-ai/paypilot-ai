module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  const railwayUrl = process.env.RAILWAY_URL;

  let twiml;
  if (railwayUrl) {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">This call may be monitored or recorded for quality assurance and training purposes. By remaining on the line, you consent to being recorded. To opt out, you may hang up at any time.</Say>
  <Pause length="1"/>
  <Connect>
    <Stream url="wss://${railwayUrl}/twilio"/>
  </Connect>
</Response>`;
  } else {
    twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">This call may be monitored or recorded for quality assurance and training purposes. By remaining on the line, you consent to being recorded. To opt out, you may hang up at any time.</Say>
  <Pause length="1"/>
  <Dial>
    <Conference
      record="record-from-start"
      waitUrl=""
      startConferenceOnEnter="true"
      endConferenceOnExit="true">
      paypilot-${Date.now()}
    </Conference>
  </Dial>
</Response>`;
  }

  return res.status(200).send(twiml);
};
