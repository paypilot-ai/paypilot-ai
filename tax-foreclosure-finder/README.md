# Tax Foreclosure Finder

A one-stop tracker for finding, researching, and pursuing tax foreclosure (and other below-market) property deals — built around the workflow described in `Phase 1`–`Phase 13` of the beginner blueprint: watch multiple counties, log every candidate property, research it before bidding, run the numbers, and reach out to owners before auction if possible.

This is a standalone tool. It does not touch or depend on PayPilot AI's code (`index.html`, `api/`, `railway/`) — it's a separate Node app that happens to live in this repo.

## What it does

- **Properties tracker** — the Phase 2 spreadsheet (owner, address, parcel #, taxes owed, estimated value, auction date, status, notes) as a searchable/filterable database instead of a spreadsheet.
- **County list import** — paste a delinquent-tax list copied from a county PDF/spreadsheet (comma, tab, or pipe separated). The app guesses which column is owner/address/parcel/taxes/value/date, shows you an editable mapping + preview, and only saves after you confirm. No county is scraped automatically — there's no reliable generic way to do that across dozens of different county sites, so this app treats "get the list" as your manual step and automates everything after it.
- **Research checklist per property** (Phase 5) — buildable, flood zone, easement, legal access, utilities, HOA, mobile homes allowed, title search status/issues.
- **Deal math** (Phase 6 & 9) — enter market value, repair cost, and desired profit cushion; the app computes your max bid live and flags properties where the taxes-owed price is within 15% of estimated market value (i.e. not much of a discount).
- **Quick research links** — auto-generated per property: Google Maps/Street View, Zillow, Redfin, Realtor.com, plus a county-specific GIS link and tax office link if you fill those in under Counties (Phase 11).
- **Owner outreach** (Phase 12) — an editable letter template with mail-merge placeholders, generated per property, plus a call/letter/door-knock log so you can track who you've contacted and what happened.
- **Weekly routine checklist** — the "Beginner's Weekly Routine" as a checklist that auto-resets every week.
- **Dashboard** — counts by status, properties with auctions in the next 14 days, total estimated equity across tracked properties.

## Running it

```bash
cd tax-foreclosure-finder
npm install
npm start
```

Then open `http://localhost:4100`. Set `PORT` to change the port.

Data is stored in `data/db.json` (a plain JSON file — no database server required). That file is gitignored; back it up yourself if you care about the data (or point `DB_PATH` logic in `db.js` at a synced folder).

## Notes / limitations

- **Ingestion is manual-paste, by design.** Every county publishes delinquent tax lists in a different format (PDF tables, Excel exports, plain HTML). Rather than build brittle scrapers per county that break the moment a site changes, this app makes the paste → map → import step fast instead. If you want a specific county auto-scraped later, point me at that county's actual page/PDF format and I can add a dedicated importer for it.
- **No automated calling.** PayPilot AI (the sibling app in this repo) has an AI outbound-calling engine, but wiring it to auto-call property owners about their tax debt is a materially different, higher-stakes product decision (consent, compliance, tone) than logging your own manual calls — so it's intentionally not connected here. The outreach tab lets you log calls/letters/door-knocks and generate a mail-merge letter instead.
- **This is not legal, financial, or investment advice.** Tax foreclosure rules, redemption periods, title risk, and bidding procedures vary by state and county. Always verify auction rules and consult a real estate attorney/title company before bidding, per Phase 7 and Phase 10 of the workflow.
