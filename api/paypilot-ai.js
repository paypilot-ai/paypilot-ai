import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const { messages } = req.body;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: messages.map((m) => ({
        role: m.role,
        content: [{ type: "input_text", text: m.content }]
      }))
    });

    res.status(200).json({
      output_text: response.output_text || ""
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI failed" });
  }
}
