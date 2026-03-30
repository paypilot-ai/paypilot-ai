// api/deepgram-token.js
// Runs on Vercel server only — key never reaches the browser

module.exports = function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.a6dc0846cf1cf3616b775bf574583d5a3fa88c9e;

  if (!key) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Lock to your own domain in production — set ALLOWED_ORIGIN in Vercel env vars
  const origin = req.headers.origin || '';
  const allowed = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowed === '*' ? origin : allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  return res.status(200).json({ key });
};
