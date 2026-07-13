const { requireAuth } = require('../lib/sessionAuth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Internal-Secret');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!requireAuth(req, res)) return;

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Resend not configured' });

  const {
    customerName,
    customerEmail,
    callReason,
    senderEmail,
    subject,
    message,
    fileContent,
    fileName,
    docuSignLink
  } = req.body || {};

  if (!customerEmail) return res.status(400).json({ error: 'Customer email required' });
  if (!subject && !message && !fileContent && !docuSignLink) {
    return res.status(400).json({ error: 'Provide a subject, message, file, or DocuSign link' });
  }

  const name = customerName || 'there';
  const emailSubject = subject || (docuSignLink ? 'Your Agreement — Please Review & Sign' : 'A message from PayPilot AI');

  let bodyHtml = '';

  if (message) {
    const escaped = message.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br/>');
    bodyHtml += `<p style="color:#374151;font-size:16px;line-height:1.7;">${escaped}</p>`;
  } else if (callReason) {
    bodyHtml += `<p style="color:#374151;font-size:16px;line-height:1.7;">Thank you for speaking with us today regarding ${callReason}. As discussed, please find the details below.</p>`;
  } else {
    bodyHtml += `<p style="color:#374151;font-size:16px;line-height:1.7;">Thank you for speaking with us. Please find the attached information below.</p>`;
  }

  if (docuSignLink) {
    bodyHtml += `
      <div style="margin:28px 0;">
        <a href="${docuSignLink}" style="background:#1a6fff;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;">
          Review &amp; Sign Agreement
        </a>
      </div>`;
  }

  if (fileContent && fileName) {
    bodyHtml += `<p style="color:#374151;font-size:14px;">The document <strong>${fileName}</strong> is attached to this email.</p>`;
  }

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px;">
      <h2 style="color:#0f172a;">Hi ${name},</h2>
      ${bodyHtml}
      <p style="color:#64748b;font-size:14px;margin-top:28px;">If you have any questions, feel free to reply to this email.</p>
      <p style="color:#64748b;font-size:14px;">— The PayPilot AI Team</p>
    </div>
  `;

  const fromEmail = process.env.FROM_EMAIL || 'info@paypilotai.live';
  const fromName  = process.env.FROM_NAME  || 'PayPilot AI';
  const payload = {
    from: `${fromName} <${fromEmail}>`,
    to: [customerEmail],
    subject: emailSubject,
    html
  };

  if (senderEmail) payload.reply_to = senderEmail;
  if (fileContent && fileName) payload.attachments = [{ filename: fileName, content: fileContent }];

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
