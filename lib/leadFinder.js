// Lead Finder — one Google Places search ("insurance agency in Dallas, TX"),
// returning up to 20 open businesses that have a listed phone number.
// Reached as GET /api/search-company?action=leads&q=...&pagetoken=...
// (kept inside search-company.js because the Vercel Hobby plan caps the
// project at 12 serverless functions).

const { rateLimit } = require('./rateLimit');

async function handleLeadSearch(req, res) {
  if (!rateLimit(req, res, { key: 'lead-finder', limit: 40, windowMs: 60_000 })) return;

  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Google Places key not configured' });

  const q = String(req.query.q || '').trim().slice(0, 120);
  const pagetoken = String(req.query.pagetoken || '').trim();
  if (!q && !pagetoken) return res.status(400).json({ error: 'q is required' });

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/place/textsearch/json');
    if (pagetoken) url.searchParams.set('pagetoken', pagetoken);
    else url.searchParams.set('query', q);
    url.searchParams.set('key', apiKey);

    const search = await (await fetch(url.toString(), { signal: AbortSignal.timeout(8000) })).json();
    if (search.status === 'INVALID_REQUEST' && pagetoken) {
      // Google needs a couple of seconds before a page token becomes valid.
      return res.json({ results: [], retry: true });
    }
    if (search.status && !['OK', 'ZERO_RESULTS'].includes(search.status)) {
      return res.status(502).json({ error: `Google Places: ${search.status} ${search.error_message || ''}`.trim() });
    }

    const places = (search.results || []).filter(p => p.business_status !== 'CLOSED_PERMANENTLY');

    const details = await Promise.all(places.map(async p => {
      try {
        const d = new URL('https://maps.googleapis.com/maps/api/place/details/json');
        d.searchParams.set('place_id', p.place_id);
        d.searchParams.set('fields', 'name,formatted_phone_number,website,formatted_address,business_status');
        d.searchParams.set('key', apiKey);
        const r = (await (await fetch(d.toString(), { signal: AbortSignal.timeout(6000) })).json()).result || {};
        if (!r.formatted_phone_number || r.business_status === 'CLOSED_PERMANENTLY') return null;
        let website = '';
        if (r.website) { try { website = new URL(r.website).hostname.replace(/^www\./, ''); } catch { website = r.website; } }
        return {
          company: r.name || p.name,
          phone: r.formatted_phone_number,
          address: r.formatted_address || p.formatted_address || '',
          website,
          placeId: p.place_id,
        };
      } catch { return null; }
    }));

    return res.json({ results: details.filter(Boolean), nextPageToken: search.next_page_token || null });
  } catch (err) {
    console.error('lead-finder error:', err.message);
    return res.status(500).json({ error: err.message || 'Lead search failed' });
  }
}

module.exports = { handleLeadSearch };
