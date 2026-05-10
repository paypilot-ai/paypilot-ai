// api/twilio-twiml.js
// Returns TwiML instructions to Twilio when a call connects
// Connects the call to a conference so both sides can be recorded and streamed

module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'text/xml');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">This call may be monitored or recorded for quality assurance and training purposes. By remaining on the line, you consent to being recorded. To opt out, you may hang up at any time.</Say>
  <Pause length="1"/>
  <Dial>
    <Conference
      record="record-from-start"
      recordingStatusCallback="https://paypilot-ai.vercel.app/api/twilio-recording"
      waitUrl=""
      startConferenceOnEnter="true"
      endConferenceOnExit="true">
      paypilot-session
    </Conference>
  </Dial>
</Response>`;

  return res.status(200).send(twiml);
};
