// api/test-google.js — delete after testing

module.exports = async function handler(req, res) {
  const key = process.env.GOOGLE_PLACES_KEY;
  
  if (!key) return res.status(500).json({ error: 'No Google key found' });

  try {
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=Google&inputtype=textquery&fields=place_id,name,formatted_address&key=${key}`;
    const resp = await fetch(url);
    const data = await resp.json();
    return res.status(200).json({ status: data.status, candidates: data.candidates, error_message: data.error_message });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
