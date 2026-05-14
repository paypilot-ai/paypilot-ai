const fs = require('fs');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  const sid = (req.query?.sid || '').replace(/[^A-Za-z0-9]/g, '');
  if (!sid) return res.status(400).json({ text: '', ts: 0 });

  try {
    const raw = fs.readFileSync(`/tmp/speech_${sid}.json`, 'utf8');
    return res.status(200).json(JSON.parse(raw));
  } catch (e) {
    return res.status(200).json({ text: '', ts: 0 });
  }
};
