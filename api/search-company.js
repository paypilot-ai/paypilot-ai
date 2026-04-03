
// api/search-company.js
// Google Places API proxy — returns top 3 results so user can pick the right one

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
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      return res.status(200).json({ found: false, status: data.status });
    }

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

    // Return top 3 results so user can pick the right location
    const results = data.results.slice(0, 3).map(place => ({
      company: place.name,
      address: place.formatted_address,
      phone: place.formatted_phone_number || 'Not listed',
      website: place.website || 'Not listed',
      industry: (place.types || []).map(t => typeMap[t]).find(Boolean) || 'Business',
      rating: place.rating || null,
      place_id: place.place_id
    }));

    return res.status(200).json({ found: true, results });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
