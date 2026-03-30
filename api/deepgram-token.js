export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.DEEPGRAM_API_KEY;

  if (!key) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  res.status(200).json({ key });
}
