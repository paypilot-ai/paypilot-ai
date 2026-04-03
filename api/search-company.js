// api/search-company.js
// Google Places API proxy — key never touches the browser

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) return res.status(500).json({ error: 'Google API key not configured' });

  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'No query provided' });

  try {
    // Single call — Text Search API (simpler, more reliable)
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&fields=name,formatted_address,formatted_phone_number,website,types,rating&key=${key}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      return res.status(200).json({ found: false, status: data.status });
    }

    const place = data.results[0];

    // Map types to industry
    const typeMap = {
      food: 'Food & Beverage', restaurant: 'Food & Beverage',
      store: 'Retail', shopping_mall: 'Retail',
      finance: 'Finance', bank: 'Finance',
      health: 'Healthcare', hospital: 'Healthcare',
      school: 'Education', university: 'Education',
      lodging: 'Hospitality', hotel: 'Hospitality',
      car_dealer: 'Automotive', car_repair: 'Automotive',
      grocery_or_supermarket: 'Grocery', supermarket: 'Grocery',
      wholesale: 'Wholesale Distribution'
    };
    const types = place.types || [];
    const industry = types.map(t => typeMap[t]).find(Boolean) || 'Business';

    return res.status(200).json({
      found: true,
      company: place.name,
      address: place.formatted_address,
      phone: place.formatted_phone_number || 'Not listed',
      website: place.website || 'Not listed',
      industry,
      rating: place.rating || null
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
