const twilio = require('twilio');

function getRequestUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const path = req.originalUrl || req.url;
  return `https://${host}${path}`;
}

// Confirms an incoming request actually came from Twilio (not forged) by
// checking the X-Twilio-Signature header against the request URL + POST body,
// signed with your Twilio Auth Token. Set SKIP_TWILIO_SIGNATURE_CHECK=true as
// an emergency kill-switch if URL reconstruction ever mismatches in production
// (e.g. behind an unexpected proxy) and calls start failing.
function validateTwilioRequest(req, authToken) {
  if (process.env.SKIP_TWILIO_SIGNATURE_CHECK === 'true') return true;
  if (!authToken) return false;
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;
  const url = getRequestUrl(req);
  const params = (req.body && typeof req.body === 'object') ? req.body : {};
  try {
    return twilio.validateRequest(authToken, signature, url, params);
  } catch (e) {
    console.error('[twilio-auth] validation error:', e.message);
    return false;
  }
}

module.exports = { validateTwilioRequest, getRequestUrl };
