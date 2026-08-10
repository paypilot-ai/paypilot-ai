# Penny Deal Scanner (personal use)

A small local dashboard that hunts for possible Home Depot penny/clearance
deals from two sources and merges them:

1. **Community reports** — searches Reddit's public JSON API for recent
   posts mentioning Home Depot penny finds and pulls out SKUs / Internet #s
   people have posted.
2. **Official clearance listings** — scrapes homedepot.com's own search
   results (via the structured data it embeds for SEO) for cheap items
   matching your search terms.

Every candidate SKU found is then re-checked directly against its Home Depot
product page to get a **live price**, so you're not just trusting a
months-old Reddit post.

## Running it

```bash
cd home-depot-penny-scanner
npm install
npm start
```

Then open http://localhost:4100.

Enter your zip code and click **Find store** to try to auto-detect your
Home Depot store number, or just type your store number directly (it's on
any recent receipt or in the Home Depot app under "My Store"). Click
**Scan now**, or turn on auto-refresh to have it re-scan on a timer while you
leave the tab open.

## Important limitations — please read

- **This is not an official API.** Home Depot doesn't publish a penny-price
  feed anywhere online — those prices are register-only markdowns. This tool
  can only surface *candidates*: items the community has flagged, or items
  that are heavily discounted online. It cannot guarantee an item will
  actually scan for a penny at your specific store.
- **Home Depot actively blocks bots.** Their site (Akamai) may return
  challenge pages instead of real data, especially if you scan frequently.
  If you see `"homedepotClearance": {"ok": false}` in the status bar, that
  source failed for this scan — the Reddit-based leads will still show.
  Don't crank the auto-refresh interval below 15 minutes; it won't get you
  better data, just more likely to get temporarily blocked.
- **Reported prices are unverified.** Anyone can post anything on Reddit.
  Always confirm the actual price at checkout (or by scanning the barcode
  with the Home Depot app in-store) before making a special trip.
- **This was built for one person's local use.** It has no auth, is meant to
  run on `localhost`, and isn't hardened for exposing to the internet or for
  many concurrent users hammering Home Depot's site at once.
- Not affiliated with, endorsed by, or connected to The Home Depot in any way.

## How it works, file by file

| File | Purpose |
|---|---|
| `server.js` | Express server: serves the dashboard and exposes `/api/scan` + `/api/store-lookup` |
| `lib/reddit.js` | Searches Reddit's public JSON search API for penny-related posts and extracts SKUs |
| `lib/homedepot.js` | Best-effort scraping of homedepot.com (store lookup, clearance search, per-SKU price verification) |
| `public/index.html` | The dashboard UI (single static file, no build step) |
