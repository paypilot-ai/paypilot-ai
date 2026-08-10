// Pulls community-reported Home Depot penny/clearance finds from Reddit's
// public read-only JSON search API (no auth required, but Reddit requires a
// descriptive User-Agent or it will 429/403 you).

const USER_AGENT = 'home-depot-penny-scanner/1.0 (personal use tool, single user)';
const SEARCH_QUERIES = [
  'home depot penny list',
  'home depot penny finds',
  '"home depot" penny sku',
  'homedepot penny',
];

// Matches things like "SKU 1001234567", "Internet #302416714", "Model# 123456"
const SKU_PATTERN = /\b(?:sku|internet\s*#?|model\s*#?|item\s*#?)\s*[:#]?\s*(\d{6,10})\b/gi;
// Matches "$0.01", "$0.02", "penny", "1 cent" style price mentions
const PENNY_PRICE_PATTERN = /\$\s?0\.0[0-9]\b/gi;

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractSkus(text) {
  const skus = new Set();
  let m;
  SKU_PATTERN.lastIndex = 0;
  while ((m = SKU_PATTERN.exec(text)) !== null) {
    skus.add(m[1]);
  }
  return [...skus];
}

async function searchQuery(query) {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=25&t=month`;
  const json = await fetchJson(url);
  const children = json?.data?.children || [];
  const leads = [];

  for (const { data: post } of children) {
    if (!post) continue;
    const text = `${post.title || ''} ${post.selftext || ''}`;
    const skus = extractSkus(text);
    if (skus.length === 0) continue;

    const isPennyMention = PENNY_PRICE_PATTERN.test(text) || /\bpenn(y|ies)\b/i.test(text);
    PENNY_PRICE_PATTERN.lastIndex = 0;

    for (const sku of skus) {
      leads.push({
        sku,
        title: post.title,
        subreddit: post.subreddit,
        permalink: `https://www.reddit.com${post.permalink}`,
        score: post.score || 0,
        createdAt: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : null,
        pennyMention: isPennyMention,
        source: 'reddit',
      });
    }
  }
  return leads;
}

async function searchRedditPennyLeads() {
  const results = await Promise.allSettled(SEARCH_QUERIES.map(searchQuery));

  const bySku = new Map();
  let anyOk = false;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    anyOk = true;
    for (const lead of r.value) {
      const existing = bySku.get(lead.sku);
      // Keep the highest-scoring / most recent report per SKU
      if (!existing || lead.score > existing.score) {
        bySku.set(lead.sku, lead);
      }
    }
  }

  return {
    ok: anyOk,
    leads: [...bySku.values()],
  };
}

module.exports = { searchRedditPennyLeads };
