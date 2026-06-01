// /api/search-company.js
// Vercel serverless function — Google Places Text Search
// Requires GOOGLE_PLACES_KEY in your Vercel environment variables

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ found: false, error: 'Method not allowed' });

  const { query } = req.query;
  if (!query || !query.trim()) return res.status(400).json({ found: false, error: 'Query is required' });

  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (!apiKey) return res.status(500).json({ found: false, error: 'API key not configured' });

  try {
    const baseQuery = query.trim();

    // Run two searches in parallel: plain name and name + "inc" to catch corporate listings
    const queries = [baseQuery, baseQuery + ' inc'];
    const allPlaces = new Map(); // dedupe by place_id

    await Promise.all(queries.map(async (q) => {
      const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
      url.searchParams.set('query', q);
      url.searchParams.set('key', apiKey);
      // No type filter — corporate offices aren't always "establishment"
      const resp = await fetch(url.toString());
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.status === 'OK' && data.results) {
        for (const place of data.results) {
          if (!allPlaces.has(place.place_id)) allPlaces.set(place.place_id, place);
        }
      }
    }));

    if (allPlaces.size === 0) return res.json({ found: false, results: [] });

    // Sort by user_ratings_total descending — the real HQ has the most reviews.
    // Registered agent addresses and satellite offices have very few or zero.
    const sorted = [...allPlaces.values()].sort(
      (a, b) => (b.user_ratings_total || 0) - (a.user_ratings_total || 0)
    );

    const top5 = sorted.slice(0, 5);

    const industryMap = {
      food: 'Food & Beverage', restaurant: 'Restaurant',
      grocery_or_supermarket: 'Grocery / Supermarket', store: 'Retail',
      clothing_store: 'Clothing', hardware_store: 'Hardware',
      car_dealer: 'Automotive', car_repair: 'Auto Repair',
      hospital: 'Healthcare', doctor: 'Medical', pharmacy: 'Pharmacy',
      lodging: 'Hospitality', real_estate_agency: 'Real Estate',
      insurance_agency: 'Insurance', bank: 'Banking', accounting: 'Accounting',
      lawyer: 'Legal', school: 'Education', university: 'Higher Education',
      gym: 'Fitness', beauty_salon: 'Beauty', spa: 'Spa & Wellness',
      electrician: 'Electrical Services', plumber: 'Plumbing',
      roofing_contractor: 'Roofing', general_contractor: 'Construction',
      moving_company: 'Moving & Storage', storage: 'Storage',
      travel_agency: 'Travel', shipping: 'Shipping & Logistics',
      warehouse: 'Warehousing', wholesaler: 'Wholesale Distribution',
    };

    const detailPromises = top5.map(async (place) => {
      try {
        const detailUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
        detailUrl.searchParams.set('place_id', place.place_id);
        detailUrl.searchParams.set('fields', 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,types,business_status');
        detailUrl.searchParams.set('key', apiKey);

        const detailResp = await fetch(detailUrl.toString());
        const detailData = await detailResp.json();
        const d = detailData.result || {};

        const rawTypes = d.types || place.types || [];
        let industry = 'Business';
        for (const t of rawTypes) {
          if (industryMap[t]) { industry = industryMap[t]; break; }
        }

        let website = 'Not listed';
        if (d.website) {
          try { website = new URL(d.website).hostname.replace(/^www\./, ''); }
          catch { website = d.website; }
        }

        return {
          company:  d.name || place.name,
          address:  d.formatted_address || place.formatted_address || 'Address not listed',
          phone:    d.formatted_phone_number || 'Not listed',
          website,
          industry,
          rating:         d.rating || place.rating || null,
          reviewCount:    d.user_ratings_total || place.user_ratings_total || 0,
          placeId:        place.place_id,
        };
      } catch {
        return {
          company:  place.name,
          address:  place.formatted_address || 'Address not listed',
          phone:    'Not listed', website: 'Not listed', industry: 'Business',
          rating:   place.rating || null, reviewCount: place.user_ratings_total || 0,
          placeId:  place.place_id,
        };
      }
    });

    const results = (await Promise.all(detailPromises)).filter(Boolean);

    return res.json({ found: results.length > 0, results, total: allPlaces.size });

  } catch (err) {
    console.error('search-company error:', err.message);
    return res.status(500).json({ found: false, error: err.message || 'Search failed' });
  }
};
