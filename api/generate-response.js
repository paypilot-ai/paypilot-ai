// api/generate-response.js
// Secure OpenAI proxy — key never touches the browser

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OpenAI key not configured' });

  const { messages } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages provided' });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        max_tokens: 300,
        temperature: 0.7
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || 'OpenAI error' });

    const reply = data.choices?.[0]?.message?.content?.trim() || '';
    return res.status(200).json({ reply });

  } catch(e) {
    return res.status(500).json({ error: 'Server error' });
  }
};
