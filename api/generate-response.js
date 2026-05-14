module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OpenAI API key not configured' });

  const body   = req.body || {};
  const system = body.system || 'You are a helpful sales assistant.';
  const msgs   = Array.isArray(body.messages) ? body.messages : [];

  if (msgs.length === 0) return res.status(400).json({ error: 'No messages provided' });

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: body.max_tokens || 300,
        messages: [{ role: 'system', content: system }, ...msgs]
      })
    });

    clearTimeout(timeout);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'OpenAI error' });
    }

    return res.status(200).json({ reply: data.choices?.[0]?.message?.content || '' });

  } catch (e) {
    clearTimeout(timeout);
    const msg = e.name === 'AbortError' ? 'Request timed out — try again' : e.message;
    return res.status(500).json({ error: msg });
  }
};
