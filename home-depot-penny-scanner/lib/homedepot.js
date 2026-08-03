// Best-effort helpers for talking to homedepot.com directly.
//
// IMPORTANT: Home Depot has no public API for this and actively blocks
// automated traffic (Akamai bot protection). These functions scrape public
// HTML/JSON-LD structured data that HD includes for SEO, which is far more
// stable than reverse-engineering their internal endpoints, but it can still
// break at any time or return a bot-check page instead of real data. Every
// function here fails soft (returns null/[] and a status flag) so a bad day
// on Home Depot's end never crashes the scan.

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchText(url, { storeId, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html' };
    if (storeId) {
      // THD_LOCATOR_STORE_ID is the cookie homedepot.com uses client-side to
      // localize pricing/availability to a specific store.
      headers.Cookie = `THD_LOCATOR_STORE_ID=${encodeURIComponent(storeId)}`;
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      blocks.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // malformed/partial JSON-LD - skip it
    }
  }
  return blocks;
}

function findProductNode(nodes) {
  for (const node of nodes) {
    if (node && (node['@type'] === 'Product' || node['@type']?.includes?.('Product'))) {
      return node;
    }
  }
  return null;
}

/** Try to resolve a Home Depot store number from a zip code. Best effort. */
async function resolveStoreByZip(zip) {
  try {
    const html = await fetchText(
      `https://www.homedepot.com/l/store-locator?zipcode=${encodeURIComponent(zip)}`
    );
    const idMatch = html.match(/"storeId"\s*:\s*"?(\d+)"?/);
    const nameMatch = html.match(/"storeName"\s*:\s*"([^"]+)"/);
    if (!idMatch) return { ok: false, storeId: null, storeName: null };
    return { ok: true, storeId: idMatch[1], storeName: nameMatch ? nameMatch[1] : null };
  } catch (err) {
    return { ok: false, storeId: null, storeName: null, error: String(err) };
  }
}

/** Look up the current listed price for a SKU/Internet# by hitting its product page. */
async function verifyProductPrice(sku, storeId) {
  try {
    const html = await fetchText(`https://www.homedepot.com/p/${encodeURIComponent(sku)}`, { storeId });
    const nodes = extractJsonLd(html);
    const product = findProductNode(nodes);
    const price = product?.offers?.price ?? product?.offers?.[0]?.price ?? null;
    if (!product || price == null) return { ok: false, sku, price: null };
    return {
      ok: true,
      sku,
      name: product.name || null,
      price: Number(price),
      availability: product.offers?.availability || product.offers?.[0]?.availability || null,
      url: `https://www.homedepot.com/p/${sku}`,
    };
  } catch (err) {
    return { ok: false, sku, price: null, error: String(err) };
  }
}

/** Search HD's own site for a keyword and pull out low-priced results (best effort). */
async function searchClearance(keyword, storeId, maxPrice = 5) {
  try {
    const html = await fetchText(
      `https://www.homedepot.com/s/${encodeURIComponent(keyword)}?NCNI-5`,
      { storeId }
    );
    const nodes = extractJsonLd(html);
    const items = [];
    for (const node of nodes) {
      const products = node['@type'] === 'ItemList' ? node.itemListElement || [] : [node];
      for (const entry of products) {
        const product = entry.item || entry;
        if (!product || product['@type'] !== 'Product') continue;
        const price = Number(product.offers?.price ?? product.offers?.[0]?.price ?? NaN);
        if (!Number.isFinite(price) || price > maxPrice) continue;
        const url = product.url || product.offers?.url || null;
        const skuMatch = url ? url.match(/\/(\d{6,10})$/) : null;
        items.push({
          sku: skuMatch ? skuMatch[1] : null,
          name: product.name || null,
          price,
          url,
          source: 'homedepot-clearance',
        });
      }
    }
    return { ok: true, items };
  } catch (err) {
    return { ok: false, items: [], error: String(err) };
  }
}

module.exports = { resolveStoreByZip, verifyProductPrice, searchClearance };
