// api/send-email.js
// Sends follow-up emails via Resend. Reply-To is set to the rep's email
// so prospect replies land directly in the rep's inbox.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(500).json({ error: 'Email service not configured' });

  const { to, subject, body, repName, repEmail, company } = req.body || {};
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, and body are required' });
  if (!repEmail) return res.status(400).json({ error: 'repEmail is required' });

  const fromName = repName ? `${repName} at ${company || 'PayPilot AI'}` : (company || 'PayPilot AI');
  const fromAddress = `noreply@paypilotai.live`;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f7ff;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7ff;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(13,27,46,.10);">
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#0f5fe8,#1a6fff);padding:28px 36px;">
          <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:22px;font-weight:800;color:#fff;letter-spacing:-.03em;">PayPilot AI</div>
          <div style="font-size:13px;color:rgba(255,255,255,.70);margin-top:2px;">Message from ${fromName}</div>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px 36px;">
          <div style="font-size:15px;line-height:1.85;color:#1e293b;white-space:pre-wrap;">${body.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 36px;border-top:1px solid #e8eef8;background:#f8faff;">
          <div style="font-size:12px;color:#94a3b8;line-height:1.7;">
            This email was sent by ${fromName} using PayPilot AI.<br>
            To reply, simply respond to this email — your message goes directly to ${repEmail}.<br>
            <a href="mailto:${repEmail}" style="color:#1a6fff;">${repEmail}</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromAddress}>`,
        reply_to: repEmail,
        to: [to],
        subject,
        html,
        text: body,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) return res.status(500).json({ error: data.message || 'Email failed' });

    return res.status(200).json({ id: data.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
