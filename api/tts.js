// TEMPORARY: requireAuth() disabled until AUTH_SECRET etc. are set (see
// loginDemo() in index.html for the matching rollback).
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const API_KEY  = process.env.ELEVENLABS_API_KEY;

module.exports = async function handler(req, res) {
  const text = (req.query.text || '').trim().slice(0, 500);
  if (!text)    return res.status(400).send('missing text');
  if (!API_KEY) return res.status(500).send('no ElevenLabs key');

  const start = Date.now();
  try {
    const el = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: { use_speaker_boost: true, stability: 0.5 },
        })
      }
    );
    if (!el.ok) return res.status(502).send('ElevenLabs error ' + el.status);
    const buf = Buffer.from(await el.arrayBuffer());
    console.log(`[tts] "${text.slice(0, 40)}" took ${Date.now() - start}ms`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(buf);
  } catch (e) {
    res.status(500).send('tts error: ' + e.message);
  }
}
