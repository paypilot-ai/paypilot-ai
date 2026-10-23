// Follow-up email for calls handled by Brandy on ElevenLabs.
//
// Brandy calls this as a tool once a prospect agrees to an email. ElevenLabs
// sends { email, customer_name, conversation_id }. There is no shared secret:
// the request is trusted only if ElevenLabs confirms the conversation is a live
// or recent call by Brandy that PayPilot placed. The rest of the email context
// (company, call reason, sender) is read from that conversation, not from the
// request, so a caller can't make this send arbitrary content.
const { sendFollowUpEmail } = require('./ai-respond');

const EL_HOSTS = ['https://api.us.elevenlabs.io', 'https://api.elevenlabs.io'];
const AGENT_ID = () => (process.env.ELEVENLABS_AGENT_ID || 'agent_8701m5jkzbzfe8ybw4k8qx3vpypk').trim();
const MAX_AGE_SECS = 60 * 60;          // only calls started in the last hour
const sentFor = new Set();             // best effort: one email per call per warm instance

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function getConversation(id, key) {
  for (const host of EL_HOSTS) {
    try {
      const r = await fetch(`${host}/v1/convai/conversations/${encodeURIComponent(id)}`, { headers: { 'xi-api-key': key } });
      if (r.ok) return await r.json();
    } catch (_) { /* try next host */ }
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return res.status(500).json({ result: 'Email is not set up. Tell them someone will follow up.' });

  const { email, customer_name, conversation_id } = req.body || {};
  const to = String(email || '').trim().replace(/\s+/g, '').toLowerCase();
  if (!EMAIL_RE.test(to)) {
    return res.status(200).json({ result: 'That email address looks incomplete. Ask them to repeat it.' });
  }
  if (!conversation_id) return res.status(400).json({ result: 'Missing call reference. Tell them someone will follow up.' });

  const convo = await getConversation(conversation_id, key);
  const started = convo && convo.metadata && convo.metadata.start_time_unix_secs;
  const vars = (convo && convo.conversation_initiation_client_data && convo.conversation_initiation_client_data.dynamic_variables) || {};
  const valid = convo
    && convo.agent_id === AGENT_ID()
    && vars.paypilot_call === 'yes'                        // set only by api/ai-call.js
    && started && (Date.now() / 1000 - started) < MAX_AGE_SECS;
  if (!valid) return res.status(403).json({ result: 'Could not verify this call. Tell them someone will follow up.' });

  if (!process.env.RESEND_API_KEY) {
    return res.status(200).json({ result: 'Email is not set up. Tell them someone will follow up.' });
  }
  if (sentFor.has(conversation_id)) {
    return res.status(200).json({ result: 'The email was already sent on this call.' });
  }
  sentFor.add(conversation_id);

  try {
    await sendFollowUpEmail(to, vars.sender_email || '', customer_name || vars.customer_name || '', vars.company_name || '', vars.call_reason || '');
    return res.status(200).json({ result: `Email sent to ${to}. Tell them it's on its way.` });
  } catch (e) {
    sentFor.delete(conversation_id);
    console.error('[brandy-email] send failed', e.message);
    return res.status(200).json({ result: 'The email did not go through. Tell them someone will follow up by email.' });
  }
};
