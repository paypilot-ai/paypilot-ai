// TEMPORARY: requireAuth() disabled until AUTH_SECRET etc. are set (see
// loginDemo() in index.html for the matching rollback).

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return res.status(500).json({ error: 'Deepgram API key not configured' });

  res.status(200).json({ key });
};
