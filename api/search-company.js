// /api/search-company.js
// Hybrid lookup:
//  1. Clearbit autocomplete (free) → company name + domain
//  2. Wikipedia summary (free) → HQ city/state
//  3. Google Places (phone number only — address comes from Wikipedia)

const { rateLimit } = require('../lib/rateLimit');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ found: false, error: 'Method not allowed' });
  if (!rateLimit(req, res, { key: 'search-company', limit: 10, windowMs: 60_000 })) return;

  const { query } = req.query;
  if (!query?.trim()) return res.status(400).json({ found: false, error: 'Query is required' });

  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (!apiKey) return res.status(500).json({ found: false, error: 'API key not configured' });

  const baseQuery = query.trim();

  // ── 1. Clearbit autocomplete — get verified company name + domain ──
  let domain = null;
  let clearbitName = null;
  try {
    const cbResp = await fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(baseQuery)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (cbResp.ok) {
      const cb = await cbResp.json();
      if (cb.length > 0) { domain = cb[0].domain; clearbitName = cb[0].name; }
    }
  } catch (_) {}

  const companyName = clearbitName || baseQuery;

  // ── 2. Wikipedia summary — extract HQ city/state ──
  let hqAddress = null;
  try {
    // Search Wikipedia for the article
    const wikiSearch = await fetch(
      `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(companyName)}&limit=1&format=json`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (wikiSearch.ok) {
      const [, titles] = await wikiSearch.json();
      if (titles.length > 0) {
        const title = encodeURIComponent(titles[0]);
        const summaryResp = await fetch(
          `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`,
          { signal: AbortSignal.timeout(3000) }
        );
        if (summaryResp.ok) {
          const summary = await summaryResp.json();
          const extract = summary.extract || '';
          // Extract headquarters from text: "headquartered in X, Y" or "based in X, Y"
          const hqMatch = extract.match(/(?:headquartered|based|located|founded)[^.]*?\bin\s+([A-Z][a-zA-Z\s]+,\s*[A-Z][a-zA-Z\s]+?)(?:[,.]|$)/);
          if (hqMatch) hqAddress = hqMatch[1].trim();
        }
      }
    }
  } catch (_) {}

  // ── 3. Google Places — reliable for phone number, not address ──
  try {
    const searchUrl = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    searchUrl.searchParams.set('query', domain ? `${companyName} ${domain}` : companyName);
    searchUrl.searchParams.set('key', apiKey);

    const searchResp = await fetch(searchUrl.toString());
    if (!searchResp.ok) throw new Error(`Google Places HTTP ${searchResp.status}`);
    let searchData = await searchResp.json();
    if (searchData.status && searchData.status !== 'OK' && searchData.status !== 'ZERO_RESULTS') {
      throw new Error(`Google Places: ${searchData.status} — ${searchData.error_message || 'check API key and billing'}`);
    }

    // Fallback to plain name if domain search empty
    if (domain && !searchData.results?.length) {
      const fb = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
      fb.searchParams.set('query', companyName);
      fb.searchParams.set('key', apiKey);
      const fbResp = await fetch(fb.toString());
      if (fbResp.ok) searchData = await fbResp.json();
    }

    const sorted = [...(searchData.results || [])].sort(
      (a, b) => (b.user_ratings_total || 0) - (a.user_ratings_total || 0)
    );
    const top5 = sorted.slice(0, 5);

    if (!top5.length && !domain) return res.json({ found: false, results: [] });

    // If no Google results but Clearbit found the company, return basic info
    if (!top5.length) {
      return res.json({
        found: true,
        results: [{
          company: companyName,
          address: hqAddress || 'See website for address',
          phone: 'Not listed',
          website: domain,
          industry: 'Business',
          rating: null,
          reviewCount: 0,
        }]
      });
    }

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

    const detailPromises = top5.map(async (place, idx) => {
      try {
        const detailUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
        detailUrl.searchParams.set('place_id', place.place_id);
        detailUrl.searchParams.set('fields', 'name,formatted_address,formatted_phone_number,website,rating,user_ratings_total,types');
        detailUrl.searchParams.set('key', apiKey);
        const d = ((await (await fetch(detailUrl.toString())).json()).result) || {};

        const rawTypes = d.types || place.types || [];
        let industry = 'Business';
        for (const t of rawTypes) { if (industryMap[t]) { industry = industryMap[t]; break; } }

        let website = 'Not listed';
        if (d.website) {
          try { website = new URL(d.website).hostname.replace(/^www\./, ''); } catch { website = d.website; }
        }
        if (website === 'Not listed' && domain) website = domain;

        // Use Wikipedia HQ address for top result if available; otherwise use Google's address
        const address = (idx === 0 && hqAddress) ? hqAddress : (d.formatted_address || place.formatted_address || 'Address not listed');

        return {
          company:     idx === 0 ? companyName : (d.name || place.name),
          address,
          phone:       d.formatted_phone_number || 'Not listed',
          website,
          industry,
          rating:      d.rating || place.rating || null,
          reviewCount: d.user_ratings_total || place.user_ratings_total || 0,
          placeId:     place.place_id,
        };
      } catch {
        return {
          company: place.name,
          address: (idx === 0 && hqAddress) ? hqAddress : (place.formatted_address || 'Not listed'),
          phone: 'Not listed', website: domain || 'Not listed',
          industry: 'Business', rating: null, reviewCount: 0,
        };
      }
    });

    const results = (await Promise.all(detailPromises)).filter(Boolean);
    return res.json({ found: results.length > 0, results, total: searchData.results?.length || 0 });

  } catch (err) {
    console.error('search-company error:', err.message);
    return res.status(500).json({ found: false, error: err.message || 'Search failed' });
  }
};
