// Follow-up email for calls handled by Brandy on ElevenLabs.
//
// Brandy calls this as a tool once the person on the call confirms their
// email. ElevenLabs sends { email, customer_name, conversation_id }.
//
// The email is the PayPilot customer's own: their company name, their subject
// and message from the AI Caller / Auto-Dialer form, and replies go to the
// "Your Email (reply-to)" they entered. Nothing about PayPilot itself is added.
//
// There is no shared secret: the request is trusted only if ElevenLabs
// confirms the conversation is a recent call by Brandy that PayPilot placed.
// The email content is read from that conversation, never from the request,
// so a caller can't make this send arbitrary content.

const EL_HOSTS = ['https://api.us.elevenlabs.io', 'https://api.elevenlabs.io'];
const AGENT_ID = () => (process.env.ELEVENLABS_AGENT_ID || 'agent_8701m5jkzbzfe8ybw4k8qx3vpypk').trim();
const MAX_AGE_SECS = 60 * 60;          // only calls started in the last hour
const sentFor = new Set();             // best effort: one email per call per warm instance

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Keep a display name safe for an email "From" header.
const headerName = (t) => String(t).replace(/["<>\r\n]/g, '').trim().slice(0, 80);

async function getConversation(id, key) {
  for (const host of EL_HOSTS) {
    try {
      const r = await fetch(`${host}/v1/convai/conversations/${encodeURIComponent(id)}`, { headers: { 'xi-api-key': key } });
      if (r.ok) return await r.json();
    } catch (_) { /* try next host */ }
  }
  return null;
}

function buildEmail(vars, customerName) {
  const company = (vars.company_name || '').trim();
  const name    = (customerName || vars.customer_name || '').trim().split(/\s+/)[0] || 'there';
  const subject = (vars.email_subject || '').trim()
    || (company ? `Following up from our call — ${company}` : 'Following up from our call');
  const message = (vars.email_message || '').trim()
    || `Thanks for taking the time to talk today. As promised, here's a quick follow-up${company ? ` from ${company}` : ''}. If you have any questions, just reply to this email.`;
  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;">
      <h2 style="color:#0f172a;">Hi ${esc(name)},</h2>
      <p style="color:#374151;font-size:16px;line-height:1.7;">${esc(message).replace(/\n/g, '<br/>')}</p>
      ${company ? `<p style="color:#64748b;font-size:14px;margin-top:28px;">— ${esc(company)}</p>` : ''}
    </div>`;
  return { subject, html, fromName: headerName(company) || (process.env.FROM_NAME || 'PayPilot AI') };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  const resendKey = process.env.RESEND_API_KEY;
  if (!key || !resendKey) return res.status(200).json({ result: 'Email is not set up. Tell them someone will follow up.' });

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

  if (sentFor.has(conversation_id)) {
    return res.status(200).json({ result: 'The email was already sent on this call.' });
  }
  sentFor.add(conversation_id);

  const { subject, html, fromName } = buildEmail(vars, customer_name);
  const fromEmail = process.env.FROM_EMAIL || 'info@paypilotai.live';
  const replyTo = String(vars.sender_email || '').trim();
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: [to],
        ...(EMAIL_RE.test(replyTo) ? { reply_to: replyTo } : {}),
        subject,
        html,
      }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.message || `Resend ${r.status}`);
    }
    return res.status(200).json({ result: `Email sent to ${to}. Tell them it's on its way.` });
  } catch (e) {
    sentFor.delete(conversation_id);
    console.error('[brandy-email] send failed', e.message);
    return res.status(200).json({ result: 'The email did not go through. Tell them someone will follow up by email.' });
  }
};
