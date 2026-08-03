const path = require('path');
const express = require('express');
const { searchRedditPennyLeads } = require('./lib/reddit');
const { resolveStoreByZip, verifyProductPrice, searchClearance } = require('./lib/homedepot');

const PORT = process.env.PORT || 4100;
const DEFAULT_CLEARANCE_KEYWORDS = ['clearance', 'special buy of the day'];
const MAX_VERIFICATIONS = 25; // cap outbound requests to homedepot.com per scan
const VERIFY_CONCURRENCY = 4;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

app.get('/api/store-lookup', async (req, res) => {
  const zip = String(req.query.zip || '').trim();
  if (!zip) return res.status(400).json({ ok: false, error: 'zip is required' });
  const result = await resolveStoreByZip(zip);
  res.json(result);
});

app.get('/api/scan', async (req, res) => {
  const zip = String(req.query.zip || '').trim();
  const storeId = String(req.query.store || '').trim() || null;
  const keywords = req.query.keywords
    ? String(req.query.keywords).split(',').map((k) => k.trim()).filter(Boolean)
    : DEFAULT_CLEARANCE_KEYWORDS;

  const [redditResult, ...clearanceResults] = await Promise.allSettled([
    searchRedditPennyLeads(),
    ...keywords.map((k) => searchClearance(k, storeId)),
  ]);

  const reddit = redditResult.status === 'fulfilled' ? redditResult.value : { ok: false, leads: [] };
  const clearance = clearanceResults
    .map((r) => (r.status === 'fulfilled' ? r.value : { ok: false, items: [] }))
    .reduce(
      (acc, r) => ({ ok: acc.ok || r.ok, items: acc.items.concat(r.items || []) }),
      { ok: false, items: [] }
    );

  // Merge candidate SKUs from both sources
  const candidates = new Map();
  for (const lead of reddit.leads) {
    candidates.set(lead.sku, {
      sku: lead.sku,
      title: lead.title,
      reportedPrice: lead.pennyMention ? 0.01 : null,
      pennyMention: lead.pennyMention,
      communitySource: { subreddit: lead.subreddit, permalink: lead.permalink, score: lead.score },
    });
  }
  for (const item of clearance.items) {
    if (!item.sku) continue;
    const existing = candidates.get(item.sku) || { sku: item.sku };
    candidates.set(item.sku, {
      ...existing,
      title: existing.title || item.name,
      reportedPrice: existing.reportedPrice ?? item.price,
      clearanceSource: { name: item.name, price: item.price, url: item.url },
    });
  }

  // Verify a bounded number of candidates against live HD pricing, prioritizing
  // penny-mentioned / cheapest-reported leads first.
  const ranked = [...candidates.values()].sort((a, b) => {
    if (a.pennyMention !== b.pennyMention) return a.pennyMention ? -1 : 1;
    return (a.reportedPrice ?? Infinity) - (b.reportedPrice ?? Infinity);
  });
  const toVerify = ranked.slice(0, MAX_VERIFICATIONS);

  const verifications = await mapWithConcurrency(toVerify, VERIFY_CONCURRENCY, (c) =>
    verifyProductPrice(c.sku, storeId)
  );

  const bySku = new Map(verifications.map((v) => [v.sku, v]));
  const deals = ranked.map((c) => {
    const verified = bySku.get(c.sku);
    return {
      sku: c.sku,
      title: c.title || verified?.name || null,
      reportedPrice: c.reportedPrice,
      pennyMention: !!c.pennyMention,
      verifiedPrice: verified?.ok ? verified.price : null,
      verifiedUrl: verified?.ok ? verified.url : c.clearanceSource?.url || null,
      availability: verified?.availability || null,
      community: c.communitySource || null,
    };
  });

  deals.sort((a, b) => {
    const pa = a.verifiedPrice ?? a.reportedPrice ?? Infinity;
    const pb = b.verifiedPrice ?? b.reportedPrice ?? Infinity;
    return pa - pb;
  });

  res.json({
    scannedAt: new Date().toISOString(),
    store: { zip: zip || null, storeId },
    sources: {
      reddit: { ok: reddit.ok, leadCount: reddit.leads.length },
      homedepotClearance: { ok: clearance.ok, itemCount: clearance.items.length },
      verifiedCount: verifications.filter((v) => v.ok).length,
      verificationAttempted: toVerify.length,
    },
    deals,
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Home Depot penny scanner running at http://localhost:${PORT}`);
});
