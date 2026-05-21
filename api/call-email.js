// api/call-email.js — proxy Railway session email capture to the browser
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const { sid } = req.query;
  if (!sid) return res.status(400).json({ error: 'sid required' });

  const rawWsUrl = (process.env.RAILWAY_WS_URL || '').trim();
  if (!rawWsUrl) return res.json({ found: false });

  const railwayHttp = rawWsUrl.replace(/^wss?:\/\//, 'https://');
  try {
    const r = await fetch(`${railwayHttp}/session?callSid=${sid}`, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    return res.json(data);
  } catch (e) {
    return res.json({ found: false });
  }
};
