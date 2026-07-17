const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { readDB, writeDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 4100;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PROPERTY_FIELDS = [
  'countyId', 'owner', 'address', 'parcelNumber', 'taxesOwed', 'estimatedValue',
  'repairCost', 'profitCushion', 'auctionDate', 'saleType', 'status', 'notes',
  'isBuildable', 'floodZone', 'hasEasement', 'hasAccessRoad', 'utilitiesAvailable',
  'hoa', 'mobileHomesAllowed', 'titleSearchDone', 'titleIssues'
];

const STATUSES = [
  'watching', 'researching', 'title_check', 'pre_auction_contact',
  'auction_scheduled', 'bid_won', 'bid_lost', 'passed', 'closed'
];

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function withComputed(property) {
  const estimatedValue = property.estimatedValue || 0;
  const repairCost = property.repairCost || 0;
  const profitCushion = property.profitCushion || 0;
  const maxBid = estimatedValue - repairCost - profitCushion;
  const taxesOwed = property.taxesOwed || 0;
  let margin = null;
  let tooClose = false;
  if (estimatedValue > 0) {
    margin = (estimatedValue - taxesOwed) / estimatedValue;
    tooClose = margin < 0.15; // less than 15% below market value
  }
  return { ...property, maxBid, marginPct: margin, tooCloseToMarket: tooClose };
}

// ---------- Counties ----------

app.get('/api/counties', (req, res) => {
  const db = readDB();
  res.json(db.counties);
});

app.post('/api/counties', (req, res) => {
  const db = readDB();
  const { name, gisUrlTemplate = '', taxOfficeUrl = '', taxOfficeContact = '', notes = '' } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'County name is required' });
  const county = {
    id: crypto.randomUUID(),
    name: name.trim(),
    gisUrlTemplate,
    taxOfficeUrl,
    taxOfficeContact,
    notes,
    createdAt: new Date().toISOString()
  };
  db.counties.push(county);
  writeDB(db);
  res.status(201).json(county);
});

app.put('/api/counties/:id', (req, res) => {
  const db = readDB();
  const county = db.counties.find(c => c.id === req.params.id);
  if (!county) return res.status(404).json({ error: 'County not found' });
  const { name, gisUrlTemplate, taxOfficeUrl, taxOfficeContact, notes } = req.body || {};
  if (name !== undefined) county.name = name;
  if (gisUrlTemplate !== undefined) county.gisUrlTemplate = gisUrlTemplate;
  if (taxOfficeUrl !== undefined) county.taxOfficeUrl = taxOfficeUrl;
  if (taxOfficeContact !== undefined) county.taxOfficeContact = taxOfficeContact;
  if (notes !== undefined) county.notes = notes;
  writeDB(db);
  res.json(county);
});

app.delete('/api/counties/:id', (req, res) => {
  const db = readDB();
  const before = db.counties.length;
  db.counties = db.counties.filter(c => c.id !== req.params.id);
  if (db.counties.length === before) return res.status(404).json({ error: 'County not found' });
  writeDB(db);
  res.status(204).end();
});

// ---------- Properties ----------

app.get('/api/properties', (req, res) => {
  const db = readDB();
  let results = db.properties;
  const { countyId, status, q } = req.query;
  if (countyId) results = results.filter(p => p.countyId === countyId);
  if (status) results = results.filter(p => p.status === status);
  if (q) {
    const needle = String(q).toLowerCase();
    results = results.filter(p =>
      (p.owner || '').toLowerCase().includes(needle) ||
      (p.address || '').toLowerCase().includes(needle) ||
      (p.parcelNumber || '').toLowerCase().includes(needle)
    );
  }
  res.json(results.map(withComputed));
});

app.get('/api/properties/:id', (req, res) => {
  const db = readDB();
  const property = db.properties.find(p => p.id === req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  res.json(withComputed(property));
});

function buildPropertyFromBody(body) {
  const property = {};
  for (const field of PROPERTY_FIELDS) {
    if (body[field] === undefined) continue;
    if (['taxesOwed', 'estimatedValue', 'repairCost', 'profitCushion'].includes(field)) {
      property[field] = num(body[field]);
    } else {
      property[field] = body[field];
    }
  }
  return property;
}

app.post('/api/properties', (req, res) => {
  const db = readDB();
  const body = req.body || {};
  if (!body.address || !body.address.trim()) return res.status(400).json({ error: 'Address is required' });
  const property = {
    id: crypto.randomUUID(),
    countyId: null,
    owner: '',
    address: '',
    parcelNumber: '',
    taxesOwed: null,
    estimatedValue: null,
    repairCost: null,
    profitCushion: null,
    auctionDate: null,
    saleType: 'tax_foreclosure',
    status: 'watching',
    notes: '',
    isBuildable: 'unknown',
    floodZone: 'unknown',
    hasEasement: 'unknown',
    hasAccessRoad: 'unknown',
    utilitiesAvailable: 'unknown',
    hoa: 'unknown',
    mobileHomesAllowed: 'unknown',
    titleSearchDone: false,
    titleIssues: '',
    ...buildPropertyFromBody(body),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  if (property.status && !STATUSES.includes(property.status)) property.status = 'watching';
  db.properties.push(property);
  writeDB(db);
  res.status(201).json(withComputed(property));
});

app.put('/api/properties/:id', (req, res) => {
  const db = readDB();
  const property = db.properties.find(p => p.id === req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const updates = buildPropertyFromBody(req.body || {});
  if (updates.status && !STATUSES.includes(updates.status)) delete updates.status;
  Object.assign(property, updates, { updatedAt: new Date().toISOString() });
  writeDB(db);
  res.json(withComputed(property));
});

app.delete('/api/properties/:id', (req, res) => {
  const db = readDB();
  const before = db.properties.length;
  db.properties = db.properties.filter(p => p.id !== req.params.id);
  db.contacts = db.contacts.filter(c => c.propertyId !== req.params.id);
  if (db.properties.length === before) return res.status(404).json({ error: 'Property not found' });
  writeDB(db);
  res.status(204).end();
});

// ---------- Contact / outreach log ----------

app.get('/api/properties/:id/contacts', (req, res) => {
  const db = readDB();
  res.json(db.contacts.filter(c => c.propertyId === req.params.id).sort((a, b) => (b.date || '').localeCompare(a.date || '')));
});

app.post('/api/properties/:id/contacts', (req, res) => {
  const db = readDB();
  const property = db.properties.find(p => p.id === req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const { date, method = 'call', outcome = '', notes = '' } = req.body || {};
  const entry = {
    id: crypto.randomUUID(),
    propertyId: req.params.id,
    date: date || new Date().toISOString().slice(0, 10),
    method,
    outcome,
    notes,
    createdAt: new Date().toISOString()
  };
  db.contacts.push(entry);
  writeDB(db);
  res.status(201).json(entry);
});

app.delete('/api/contacts/:id', (req, res) => {
  const db = readDB();
  const before = db.contacts.length;
  db.contacts = db.contacts.filter(c => c.id !== req.params.id);
  if (db.contacts.length === before) return res.status(404).json({ error: 'Contact entry not found' });
  writeDB(db);
  res.status(204).end();
});

// ---------- Letter template ----------

app.get('/api/letter-template', (req, res) => {
  const db = readDB();
  res.json({ template: db.letterTemplate });
});

app.put('/api/letter-template', (req, res) => {
  const db = readDB();
  db.letterTemplate = (req.body && req.body.template) || db.letterTemplate;
  writeDB(db);
  res.json({ template: db.letterTemplate });
});

app.get('/api/properties/:id/letter', (req, res) => {
  const db = readDB();
  const property = db.properties.find(p => p.id === req.params.id);
  if (!property) return res.status(404).json({ error: 'Property not found' });
  const county = db.counties.find(c => c.id === property.countyId);
  const merged = db.letterTemplate
    .replace(/{owner}/g, property.owner || '[Owner]')
    .replace(/{address}/g, property.address || '')
    .replace(/{parcel_number}/g, property.parcelNumber || 'N/A')
    .replace(/{county}/g, county ? county.name : '')
    .replace(/{taxes_owed}/g, property.taxesOwed != null ? property.taxesOwed.toLocaleString() : 'N/A')
    .replace(/{estimated_value}/g, property.estimatedValue != null ? property.estimatedValue.toLocaleString() : 'N/A')
    .replace(/{date}/g, new Date().toLocaleDateString());
  res.json({ letter: merged });
});

// ---------- Import: paste-a-list parsing ----------

const FIELD_ALIASES = {
  owner: ['owner', 'owner name', 'taxpayer', 'name', 'grantee'],
  address: ['address', 'property address', 'situs address', 'situs', 'location'],
  parcelNumber: ['parcel', 'parcel number', 'parcel id', 'pin', 'parcel #', 'account', 'account number'],
  taxesOwed: ['taxes owed', 'amount owed', 'delinquent amount', 'taxes due', 'balance due', 'total due'],
  estimatedValue: ['estimated value', 'tax value', 'appraised value', 'assessed value', 'market value'],
  auctionDate: ['auction date', 'sale date', 'date', 'sale date/time'],
  notes: ['notes', 'comment', 'comments'],
  status: ['status']
};

function guessDelimiter(line) {
  const counts = { '\t': (line.match(/\t/g) || []).length, ',': (line.match(/,/g) || []).length, '|': (line.match(/\|/g) || []).length };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

function splitCsvLine(line, delimiter) {
  if (delimiter !== ',') return line.split(delimiter).map(s => s.trim());
  // minimal CSV-aware split (handles quoted commas)
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function guessFieldForHeader(header) {
  const h = header.toLowerCase().trim();
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.some(a => h === a || h.includes(a))) return field;
  }
  return null;
}

app.post('/api/import/parse', (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'No text provided' });
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return res.status(400).json({ error: 'No rows found' });
  const delimiter = guessDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter);
  const mapping = headers.map(h => guessFieldForHeader(h));
  const rows = lines.slice(1).map(line => splitCsvLine(line, delimiter));
  res.json({ headers, mapping, rows, delimiter });
});

app.post('/api/import/commit', (req, res) => {
  const db = readDB();
  const { countyId, headers, mapping, rows } = req.body || {};
  if (!Array.isArray(rows) || !Array.isArray(headers) || !Array.isArray(mapping)) {
    return res.status(400).json({ error: 'headers, mapping, and rows are required' });
  }
  const created = [];
  for (const row of rows) {
    const raw = {};
    headers.forEach((h, idx) => {
      const field = mapping[idx];
      if (field) raw[field] = row[idx];
    });
    if (!raw.address && !raw.owner && !raw.parcelNumber) continue; // skip empty rows
    const property = {
      id: crypto.randomUUID(),
      countyId: countyId || null,
      owner: raw.owner || '',
      address: raw.address || '',
      parcelNumber: raw.parcelNumber || '',
      taxesOwed: num(raw.taxesOwed),
      estimatedValue: num(raw.estimatedValue),
      repairCost: null,
      profitCushion: null,
      auctionDate: raw.auctionDate || null,
      saleType: 'tax_foreclosure',
      status: 'watching',
      notes: raw.notes || '',
      isBuildable: 'unknown',
      floodZone: 'unknown',
      hasEasement: 'unknown',
      hasAccessRoad: 'unknown',
      utilitiesAvailable: 'unknown',
      hoa: 'unknown',
      mobileHomesAllowed: 'unknown',
      titleSearchDone: false,
      titleIssues: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    db.properties.push(property);
    created.push(property);
  }
  writeDB(db);
  res.status(201).json({ created: created.length, properties: created.map(withComputed) });
});

// ---------- Dashboard ----------

app.get('/api/dashboard', (req, res) => {
  const db = readDB();
  const byStatus = {};
  STATUSES.forEach(s => { byStatus[s] = 0; });
  let totalPotentialEquity = 0;
  const today = new Date();
  const in14 = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
  const upcomingAuctions = [];

  for (const p of db.properties) {
    if (byStatus[p.status] !== undefined) byStatus[p.status]++;
    const computed = withComputed(p);
    if (computed.estimatedValue && computed.taxesOwed) {
      totalPotentialEquity += Math.max(0, computed.estimatedValue - computed.taxesOwed);
    }
    if (p.auctionDate) {
      const d = new Date(p.auctionDate);
      if (!isNaN(d) && d >= today && d <= in14) {
        upcomingAuctions.push({ id: p.id, owner: p.owner, address: p.address, auctionDate: p.auctionDate });
      }
    }
  }
  upcomingAuctions.sort((a, b) => a.auctionDate.localeCompare(b.auctionDate));

  res.json({
    totalProperties: db.properties.length,
    byStatus,
    totalPotentialEquity,
    upcomingAuctions,
    countyCount: db.counties.length
  });
});

// ---------- Weekly routine checklist (persisted, resets weekly) ----------

const ROUTINE_STEPS = [
  'Check all nearby county tax foreclosure / delinquent lists',
  'Add new properties to the tracker',
  'Research 5-10 properties (maps, GIS, flood zone, access, utilities)',
  'Drive by top picks',
  'Check comparable sales (Zillow/Redfin/Realtor)',
  'Attend or check auctions scheduled this week',
  'Follow up on outreach (calls/letters) to pre-foreclosure owners'
];

function currentWeekKey() {
  const d = new Date();
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

app.get('/api/weekly-routine', (req, res) => {
  const db = readDB();
  const weekKey = currentWeekKey();
  if (db.weeklyRoutine.lastReset !== weekKey) {
    db.weeklyRoutine = { lastReset: weekKey, checked: {} };
    writeDB(db);
  }
  res.json({ steps: ROUTINE_STEPS, checked: db.weeklyRoutine.checked, weekKey });
});

app.put('/api/weekly-routine', (req, res) => {
  const db = readDB();
  const weekKey = currentWeekKey();
  const { index, checked } = req.body || {};
  if (db.weeklyRoutine.lastReset !== weekKey) {
    db.weeklyRoutine = { lastReset: weekKey, checked: {} };
  }
  db.weeklyRoutine.checked[index] = !!checked;
  writeDB(db);
  res.json({ steps: ROUTINE_STEPS, checked: db.weeklyRoutine.checked, weekKey });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Tax Foreclosure Finder running at http://localhost:${PORT}`);
});
