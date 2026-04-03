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
    // Step 1 — Find Place from text search
    const searchUrl = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(query)}&inputtype=textquery&fields=place_id,name,formatted_address,geometry&key=${key}`;
    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();

    if (!searchData.candidates || searchData.candidates.length === 0) {
      return res.status(200).json({ found: false });
    }

    const place = searchData.candidates[0];
    const placeId = place.place_id;

    // Step 2 — Get full details for that place
    const detailUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,formatted_phone_number,website,business_status,types,rating&key=${key}`;
    const detailResp = await fetch(detailUrl);
    const detailData = await detailResp.json();

    const details = detailData.result || {};

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
    const types = details.types || [];
    const industry = types.map(t => typeMap[t]).find(Boolean) || 'Business';

    return res.status(200).json({
      found: true,
      company: details.name || place.name,
      address: details.formatted_address || place.formatted_address,
      phone: details.formatted_phone_number || 'Not listed',
      website: details.website || 'Not listed',
      industry,
      status: details.business_status || 'OPERATIONAL',
      rating: details.rating || null
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
