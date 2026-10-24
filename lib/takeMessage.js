// Inbound calls: Brandy answers for PayPilot AI, takes a message, and calls
// this tool to email it to PayPilot (info@paypilotai.live by default).
// Served at POST /api/ai-call?action=take-message (kept out of api/ because
// the Vercel Hobby plan allows at most 12 functions).
//
// ElevenLabs sends { caller_name, callback_number, caller_email, reason,
// message, caller_id, conversation_id }.
//
// The recipient is fixed, so the worst a stray request can do is put a note in
// PayPilot's own inbox. Still: if ElevenLabs can confirm the conversation and
// it isn't a recent Brandy call, it's rejected; one message per call.

const EL_HOSTS = ['https://api.us.elevenlabs.io', 'https://api.elevenlabs.io'];
// Brandy (AI Caller) and Brandy – PayPilot Line (PayPilot's own front desk).
const AGENT_IDS = () => [
  (process.env.ELEVENLABS_AGENT_ID || 'agent_8701m5jkzbzfe8ybw4k8qx3vpypk').trim(),
  (process.env.ELEVENLABS_FRONT_DESK_AGENT_ID || 'agent_1901m5nrvtw2fev8by8dt81812d1').trim(),
];
const MAX_AGE_SECS = 60 * 60;
const sentFor = new Set();

const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (t, n) => String(t || '').trim().slice(0, n);

async function lookup(id, key) {
  for (const host of EL_HOSTS) {
    try {
      const r = await fetch(`${host}/v1/convai/conversations/${encodeURIComponent(id)}`, { headers: { 'xi-api-key': key } });
      if (r.ok) return await r.json();
    } catch (_) { /* try next host */ }
  }
  return null; // couldn't confirm either way
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const resendKey = process.env.RESEND_API_KEY;
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!resendKey) return res.status(200).json({ result: 'MESSAGE NOT SENT. Tell them someone from PayPilot will call them back.' });

  const b = req.body || {};
  const conversationId = clip(b.conversation_id, 80);
  if (!/^conv_[A-Za-z0-9]+$/.test(conversationId)) return res.status(400).json({ result: 'MESSAGE NOT SENT. Missing call reference.' });
  if (sentFor.has(conversationId)) return res.status(200).json({ result: 'The message was already sent on this call.' });

  if (key) {
    const convo = await lookup(conversationId, key);
    const started = convo && convo.metadata && convo.metadata.start_time_unix_secs;
    if (convo && (!AGENT_IDS().includes(convo.agent_id) || !started || Date.now() / 1000 - started >= MAX_AGE_SECS)) {
      return res.status(403).json({ result: 'MESSAGE NOT SENT. Tell them someone from PayPilot will call them back.' });
    }
  }
  sentFor.add(conversationId);

  const name = clip(b.caller_name, 120) || 'Unknown caller';
  const callback = clip(b.callback_number, 40);
  const callerId = clip(b.caller_id, 40);
  const email = clip(b.caller_email, 160);
  const reason = clip(b.reason, 300);
  const message = clip(b.message, 3000);
  const to = (process.env.MESSAGE_TO_EMAIL || 'info@paypilotai.live').trim();
  const fromEmail = process.env.FROM_EMAIL || 'info@paypilotai.live';
  const row = (label, v) => v ? `<tr><td style="padding:6px 12px 6px 0;color:#64748b;vertical-align:top;">${label}</td><td style="padding:6px 0;color:#0f172a;">${esc(v).replace(/\n/g, '<br/>')}</td></tr>` : '';
  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:28px;">
      <h2 style="color:#0f172a;margin:0 0 16px;">New phone message</h2>
      <table style="font-size:15px;line-height:1.5;border-collapse:collapse;">
        ${row('From', name)}
        ${row('Call back at', callback)}
        ${row('Called from', callerId && callerId !== callback ? callerId : '')}
        ${row('Email', email)}
        ${row('Reason', reason)}
        ${row('Message', message)}
        ${row('Received', new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET')}
      </table>
      <p style="margin-top:24px;font-size:13px;color:#64748b;">Taken by Brandy. Full call: <a href="https://elevenlabs.io/app/agents/history/${encodeURIComponent(conversationId)}">transcript and recording</a></p>
    </div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from: `Brandy (PayPilot AI) <${fromEmail}>`,
        to: [to],
        ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { reply_to: email } : {}),
        subject: `Phone message from ${name}${reason ? ` — ${reason.slice(0, 60)}` : ''}`,
        html,
      }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.message || `Resend ${r.status}`);
    }
    return res.status(200).json({ result: 'Message sent. Tell them you passed it along and someone will get back to them.' });
  } catch (e) {
    sentFor.delete(conversationId);
    console.error('[take-message] send failed', e.message);
    return res.status(200).json({ result: 'MESSAGE NOT SENT. Tell them someone from PayPilot will call them back.' });
  }
};
