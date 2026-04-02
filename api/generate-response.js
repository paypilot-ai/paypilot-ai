// api/generate-response.js
import OpenAI from "openai";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OpenAI key not configured' });

  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'No messages provided' });
  }

  try {
    const openai = new OpenAI({ apiKey: key });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      max_tokens: 300,
      temperature: 0.7
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || '';
    return res.status(200).json({ reply });

  } catch(e) {
    return res.status(500).json({ error: e.message || 'OpenAI error' });
  }
}
