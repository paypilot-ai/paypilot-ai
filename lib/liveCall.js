// Live Call (Live Assist page): click-to-call through the rep's own phone.
//
// 1. start:    PayPilot calls the REP's phone. When they answer they join a
//              private Twilio conference.
// 2. answered: Twilio tells us the rep picked up; we then call the SUPPLIER
//              into the same conference. Rep and supplier talk normally.
// 3. say:      TwiML for spoken rebuttals ("Send to call"). twilio-speak.js
//              plays it into the conference, so the call stays connected.
//
// Served through api/ai-call.js (?action=live-call / live-answered / live-say)
// because the Vercel Hobby plan allows at most 12 functions.
const crypto = require('crypto');
const { validateTwilioRequest } = require('./twilioAuth');
const { getBearerToken, verifyToken } = require('./sessionAuth');

// Click-to-call and Listen are Pro/Enterprise features. Only signed-in
// customer accounts carry a plan; the owner account has no token and is allowed.
function blockedForPlan(req, res, feature) {
  const t = verifyToken(getBearerToken(req));
  if (t && String(t.plan || '').toLowerCase() === 'starter') {
    res.status(402).json({ error: `${feature} is a Pro feature. Upgrade to Pro to use it.` });
    return true;
  }
  return false;
}

const xmlEsc = (t) => String(t).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const toE164 = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : (d.length === 11 && d.startsWith('1') ? '+' + d : ''); };
const baseUrl = (req) => `https://${req.headers['x-forwarded-host'] || req.headers.host}`;

function twilioCreds() {
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const from = (process.env.TWILIO_PHONE_NUMBER || '').trim();
  return { sid, token, from, auth: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64') };
}

async function createCall(params) {
  const { sid, auth } = twilioCreds();
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Twilio: ${data.message || r.status}`);
  return data;
}

const conferenceTwiml = (name, intro) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>${intro ? `<Say voice="Polly.Joanna">${xmlEsc(intro)}</Say>` : ''}<Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="">${xmlEsc(name)}</Conference></Dial></Response>`;

// POST ?action=live-call  { toNumber, repNumber }
async function start(req, res) {
  if (blockedForPlan(req, res, 'Click-to-call')) return;
  const { sid, token, from } = twilioCreds();
  if (!sid || !token || !from) return res.status(500).json({ error: 'Twilio credentials not configured' });
  const { toNumber, repNumber } = req.body || {};
  const supplier = toE164(toNumber);
  const rep = toE164(repNumber);
  if (!supplier) return res.status(400).json({ error: 'Enter a valid 10-digit supplier number.' });
  if (!rep) return res.status(400).json({ error: 'Enter your own 10-digit phone number so PayPilot can call you first.' });
  if (rep === supplier) return res.status(400).json({ error: 'Your number and the supplier number are the same.' });

  const conference = 'pp-live-' + crypto.randomBytes(8).toString('hex');
  const callback = `${baseUrl(req)}/api/ai-call?action=live-answered&conf=${encodeURIComponent(conference)}&to=${encodeURIComponent(supplier)}`;
  try {
    const call = await createCall({
      To: rep,
      From: from,
      Twiml: conferenceTwiml(conference, 'PayPilot here. Connecting you to your call now.'),
      StatusCallback: callback,
      StatusCallbackEvent: 'answered',
      StatusCallbackMethod: 'POST',
      Timeout: '25',
    });
    return res.status(200).json({ callSid: call.sid, conference, status: call.status, to: supplier });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// POST ?action=live-answered  (Twilio status callback when the rep answers)
async function answered(req, res) {
  if (!validateTwilioRequest(req, process.env.TWILIO_AUTH_TOKEN)) return res.status(403).end();
  const { conf, to } = req.query || {};
  const status = (req.body && req.body.CallStatus) || '';
  if (status === 'in-progress' && conf && toE164(to)) {
    try {
      await createCall({ To: toE164(to), From: twilioCreds().from, Twiml: conferenceTwiml(conf, ''), Timeout: '30' });
    } catch (e) {
      console.error('[live-call] supplier dial failed', e.message);
    }
  }
  return res.status(204).end();
}

// GET ?action=live-say&t=<base64url text>&l=<language>  (TwiML for announcements)
function say(req, res) {
  if (!validateTwilioRequest(req, process.env.TWILIO_AUTH_TOKEN)) return res.status(403).end();
  let text = '';
  try { text = Buffer.from(String(req.query.t || ''), 'base64url').toString('utf8').slice(0, 1500); } catch (_) {}
  const voices = { Spanish: ['Polly.Conchita', 'es-ES'], French: ['Polly.Celine', 'fr-FR'], Portuguese: ['Polly.Ines', 'pt-BR'], English: ['Polly.Joanna', 'en-US'] };
  const [voice, lang] = voices[req.query.l] || voices.English;
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Say voice="${voice}" language="${lang}">${xmlEsc(text)}</Say>` : ''}</Response>`);
}

// Used by api/twilio-speak.js: play text into a live conference.
async function announce(req, conference, text, language) {
  const { sid, auth } = twilioCreds();
  const list = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Conferences.json?FriendlyName=${encodeURIComponent(conference)}&Status=in-progress`, { headers: { Authorization: auth } });
  const data = await list.json().catch(() => ({}));
  const conf = data.conferences && data.conferences[0];
  if (!conf) throw new Error('The call is not connected yet.');
  const t = Buffer.from(String(text)).toString('base64url');
  const url = `${baseUrl(req)}/api/ai-call?action=live-say&t=${t}&l=${encodeURIComponent(language || 'English')}`;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Conferences/${conf.sid}.json`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ AnnounceUrl: url, AnnounceMethod: 'GET' }).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || 'Twilio error');
  return d;
}

// POST ?action=listen  { callSid, stop }
// Starts (or stops) a one-way copy of a live call's audio to the Railway
// server, which relays it to the browser. The call itself is untouched.
async function listen(req, res) {
  if (!(req.body && req.body.stop) && blockedForPlan(req, res, 'Listen live')) return;
  const { sid, token, auth } = twilioCreds();
  const railway = (process.env.RAILWAY_WS_URL || '').trim().replace(/^https?:\/\//, 'wss://').replace(/\/+$/, '');
  if (!sid || !token) return res.status(500).json({ error: 'Twilio credentials not configured' });
  if (!railway) return res.status(500).json({ error: 'Live listening needs the Railway server (RAILWAY_WS_URL is not set).' });
  const { callSid, stop } = req.body || {};
  if (!/^CA[0-9a-f]{32}$/i.test(String(callSid || ''))) return res.status(400).json({ error: 'No active call to listen to.' });
  const base = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}/Streams`;
  const post = (url, params) => fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  try {
    if (stop) {
      await post(`${base}/pp-listen.json`, { Status: 'stopped' });
      return res.status(200).json({ ok: true });
    }
    const r = await post(`${base}.json`, { Url: `${railway}/listen-twilio`, Track: 'both_tracks', Name: 'pp-listen' });
    const d = await r.json().catch(() => ({}));
    // 409-style "already exists" just means someone is already listening; that's fine.
    if (!r.ok && !/already/i.test(d.message || '')) return res.status(500).json({ error: d.message || 'Could not start listening.' });
    return res.status(200).json({ ok: true, listenUrl: `${railway}/listen?callSid=${callSid}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { start, answered, say, announce, listen };
