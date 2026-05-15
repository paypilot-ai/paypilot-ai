module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = (process.env.OPENAI_API_KEY || '').trim().replace(/^=+/, '');
  if (!apiKey) return res.status(500).json({ error: 'OpenAI key not configured' });

  const body = req.body || {};
  const { max_tokens, system, messages } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: max_tokens || 120,
        temperature: 0.75,
        stream: true,
        messages: [
          { role: 'system', content: system || '' },
          ...messages
        ]
      })
    });

    if (!upstream.ok) {
      const err = await upstream.json();
      return res.status(upstream.status).json({ error: err.error?.message || 'OpenAI error' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') {
          res.write('data: [DONE]\n\n');
          continue;
        }
        try {
          const parsed = JSON.parse(payload);
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
        } catch (_) {}
      }
    }

    res.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.end();
  }
};
