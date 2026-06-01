// /api/search-company.js
// Company lookup: Clearbit autocomplete (free, no key) → domain → Google Places by domain
// Falls back to plain Google Places text search if Clearbit finds nothing

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ found: false, error: 'Method not allowed' });

  const { query } = req.query;
  if (!query?.trim()) return res.status(400).json({ found: false, error: 'Query is required' });

  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (!apiKey) return res.status(500).json({ found: false, error: 'API key not configured' });

  const baseQuery = query.trim();

  try {
    // Step 1: Clearbit autocomplete — free, no key, returns accurate domain for companies
    let domain = null;
    let clearbitName = null;
    try {
      const cbResp = await fetch(
        `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(baseQuery)}`,
        { signal: AbortSignal.timeout(3000) }
      );
      if (cbResp.ok) {
        const cbData = await cbResp.json();
        if (cbData.length > 0) {
          domain = cbData[0].domain;
          clearbitName = cbData[0].name;
        }
      }
    } catch (_) { /* Clearbit unavailable — fall through */ }

    // Step 2: Google Places text search — use domain as query if we have it (finds the right listing)
    const placesQuery = domain ? `${clearbitName || baseQuery} ${domain}` : baseQuery;
    const searchUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    searchUrl.searchParams.set('query', placesQuery);
    searchUrl.searchParams.set('key', apiKey);

    const searchResp = await fetch(searchUrl.toString());
    if (!searchResp.ok) throw new Error(`Google Places API returned ${searchResp.status}`);
    let searchData = await searchResp.json();

    // If domain search returned nothing, retry with plain company name
    if (domain && (!searchData.results?.length || searchData.status === 'ZERO_RESULTS')) {
      const fallbackUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
      fallbackUrl.searchParams.set('query', baseQuery);
      fallbackUrl.searchParams.set('key', apiKey);
      const fallbackResp = await fetch(fallbackUrl.toString());
      if (fallbackResp.ok) searchData = await fallbackResp.json();
    }

    if (!searchData.results?.length) return res.json({ found: false, results: [] });

    // Sort by review count — real HQ has the most reviews
    const sorted = [...searchData.results].sort(
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
        detailUrl.searchParams.set('fields', 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,types');
        detailUrl.searchParams.set('key', apiKey);

        const detailResp = await fetch(detailUrl.toString());
        const d = (await detailResp.json()).result || {};

        const rawTypes = d.types || place.types || [];
        let industry = 'Business';
        for (const t of rawTypes) { if (industryMap[t]) { industry = industryMap[t]; break; } }

        let website = 'Not listed';
        if (d.website) {
          try { website = new URL(d.website).hostname.replace(/^www\./, ''); } catch { website = d.website; }
        }
        // Prefer Clearbit domain if Google doesn't have a website
        if (website === 'Not listed' && domain) website = domain;

        return {
          company:     clearbitName && place === top5[0] ? clearbitName : (d.name || place.name),
          address:     d.formatted_address || place.formatted_address || 'Address not listed',
          phone:       d.formatted_phone_number || 'Not listed',
          website,
          industry,
          rating:      d.rating || place.rating || null,
          reviewCount: d.user_ratings_total || place.user_ratings_total || 0,
          placeId:     place.place_id,
        };
      } catch {
        return {
          company: place.name, address: place.formatted_address || 'Not listed',
          phone: 'Not listed', website: domain || 'Not listed', industry: 'Business',
          rating: null, reviewCount: 0, placeId: place.place_id,
        };
      }
    });

    const results = (await Promise.all(detailPromises)).filter(Boolean);
    return res.json({ found: results.length > 0, results, total: searchData.results.length });

  } catch (err) {
    console.error('search-company error:', err.message);
    return res.status(500).json({ found: false, error: err.message || 'Search failed' });
  }
};
