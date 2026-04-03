// /api/search-company.js
// Vercel serverless function — Google Places Text Search
// Requires GOOGLE_PLACES_KEY in your Vercel environment variables

export default async function handler(req, res) {
  // CORS headers — allows your frontend to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ found: false, error: 'Method not allowed' });
  }

  const { query } = req.query;

  if (!query || !query.trim()) {
    return res.status(400).json({ found: false, error: 'Query is required' });
  }

  const apiKey = process.env.GOOGLE_PLACES_KEY;

  if (!apiKey) {
    console.error('GOOGLE_PLACES_KEY is not set in environment variables');
    return res.status(500).json({ found: false, error: 'API key not configured' });
  }

  try {
    // Step 1: Text Search to find matching businesses
    const searchUrl = new URL(
      'https://maps.googleapis.com/maps/api/place/textsearch/json'
    );
    searchUrl.searchParams.set('query', query.trim());
    searchUrl.searchParams.set('key', apiKey);
    searchUrl.searchParams.set('type', 'establishment');

    const searchResp = await fetch(searchUrl.toString());

    if (!searchResp.ok) {
      throw new Error(`Google Places API returned ${searchResp.status}`);
    }

    const searchData = await searchResp.json();

    if (
      searchData.status === 'ZERO_RESULTS' ||
      !searchData.results ||
      searchData.results.length === 0
    ) {
      return res.json({ found: false, results: [] });
    }

    if (searchData.status !== 'OK' && searchData.status !== 'ZERO_RESULTS') {
      console.error('Google Places error status:', searchData.status);
      throw new Error('Google Places API error: ' + searchData.status);
    }

    // Step 2: For the top 5 results, fetch Place Details to get phone + website
    const top5 = searchData.results.slice(0, 5);

    const detailPromises = top5.map(async (place) => {
      try {
        const detailUrl = new URL(
          'https://maps.googleapis.com/maps/api/place/details/json'
        );
        detailUrl.searchParams.set('place_id', place.place_id);
        detailUrl.searchParams.set(
          'fields',
          'name,formatted_address,formatted_phone_number,website,rating,types,business_status'
        );
        detailUrl.searchParams.set('key', apiKey);

        const detailResp = await fetch(detailUrl.toString());
        const detailData = await detailResp.json();
        const d = detailData.result || {};

        // Map Google types to human-readable industry labels
        const industryMap = {
          food:                   'Food & Beverage',
          restaurant:             'Restaurant',
          grocery_or_supermarket: 'Grocery / Supermarket',
          store:                  'Retail',
          clothing_store:         'Clothing',
          hardware_store:         'Hardware',
          car_dealer:             'Automotive',
          car_repair:             'Auto Repair',
          hospital:               'Healthcare',
          doctor:                 'Medical',
          pharmacy:               'Pharmacy',
          lodging:                'Hospitality',
          real_estate_agency:     'Real Estate',
          insurance_agency:       'Insurance',
          bank:                   'Banking',
          accounting:             'Accounting',
          lawyer:                 'Legal',
          school:                 'Education',
          university:             'Higher Education',
          gym:                    'Fitness',
          beauty_salon:           'Beauty',
          spa:                    'Spa & Wellness',
          electrician:            'Electrical Services',
          plumber:                'Plumbing',
          roofing_contractor:     'Roofing',
          general_contractor:     'Construction',
          moving_company:         'Moving & Storage',
          storage:                'Storage',
          travel_agency:          'Travel',
          shipping:               'Shipping & Logistics',
          warehouse:              'Warehousing',
          wholesaler:             'Wholesale Distribution',
        };

        const rawTypes = d.types || place.types || [];
        let industry = 'Business';
        for (const t of rawTypes) {
          if (industryMap[t]) {
            industry = industryMap[t];
            break;
          }
        }

        // Clean up phone number (remove country code if present)
        let phone = d.formatted_phone_number || 'Not listed';

        // Format website — strip https/www for display
        let website = 'Not listed';
        if (d.website) {
          try {
            const url = new URL(d.website);
            website = url.hostname.replace(/^www\./, '');
          } catch {
            website = d.website;
          }
        }

        return {
          company:  d.name || place.name,
          address:  d.formatted_address || place.formatted_address || 'Address not listed',
          phone,
          website,
          industry,
          rating:   d.rating || place.rating || null,
          placeId:  place.place_id,
        };
      } catch (detailErr) {
        // If detail fetch fails for one place, return basic info from text search
        console.error('Detail fetch failed for place:', place.place_id, detailErr);
        return {
          company:  place.name,
          address:  place.formatted_address || 'Address not listed',
          phone:    'Not listed',
          website:  'Not listed',
          industry: 'Business',
          rating:   place.rating || null,
          placeId:  place.place_id,
        };
      }
    });

    const results = await Promise.all(detailPromises);

    // Filter out any null results and return
    const cleanResults = results.filter(Boolean);

    return res.json({
      found: cleanResults.length > 0,
      results: cleanResults,
      total: searchData.results.length,
    });

  } catch (err) {
    console.error('search-company error:', err.message);
    return res.status(500).json({
      found: false,
      error: err.message || 'Search failed',
    });
  }
}
