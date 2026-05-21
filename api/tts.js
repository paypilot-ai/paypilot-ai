const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'tnSpp4vdxKPjI9w0GnoV';
const API_KEY  = process.env.ELEVENLABS_API_KEY;

export default async function handler(req, res) {
  const text = (req.query.text || '').trim();
  if (!text)   return res.status(400).send('missing text');
  if (!API_KEY) return res.status(500).send('no ElevenLabs key');

  try {
    const el = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?optimize_streaming_latency=4`,
      {
        method: 'POST',
        headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { stability: 0.35, similarity_boost: 0.75, style: 0.25, use_speaker_boost: false, speed: 1.0 }
        })
      }
    );
    if (!el.ok) return res.status(502).send('ElevenLabs error ' + el.status);
    const buf = Buffer.from(await el.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    res.status(500).send('tts error: ' + e.message);
  }
}
