module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Resend not configured' });

  const { customerName, customerEmail, docuSignLink, callReason, senderEmail } = req.body || {};
  if (!customerEmail) return res.status(400).json({ error: 'Customer email required' });
  if (!docuSignLink)  return res.status(400).json({ error: 'DocuSign link required' });

  const name = customerName || 'there';

  const payload = {
    from: 'PayPilot AI <info@paypilotai.live>',
    to: [customerEmail],
    subject: 'Your Agreement — Please Review & Sign',
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;">
        <h2 style="color:#0f172a;">Hi ${name},</h2>
        <p style="color:#374151;font-size:16px;line-height:1.6;">
          Thank you for speaking with us today${callReason ? ' regarding ' + callReason : ''}.
          As discussed, please find your agreement below.
        </p>
        <div style="margin:32px 0;">
          <a href="${docuSignLink}" style="background:#1a6fff;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;">
            Review &amp; Sign Agreement
          </a>
        </div>
        <p style="color:#64748b;font-size:14px;">
          If you have any questions, feel free to reply to this email.
        </p>
        <p style="color:#64748b;font-size:14px;">— The PayPilot AI Team</p>
      </div>
    `
  };

  if (senderEmail) payload.reply_to = senderEmail;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data.message || 'Email failed' });

    return res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
