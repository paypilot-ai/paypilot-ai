const STATUSES = [
  'watching', 'researching', 'title_check', 'pre_auction_contact',
  'auction_scheduled', 'bid_won', 'bid_lost', 'passed', 'closed'
];
const STATUS_LABELS = {
  watching: 'Watching',
  researching: 'Researching',
  title_check: 'Title Check',
  pre_auction_contact: 'Pre-Auction Contact',
  auction_scheduled: 'Auction Scheduled',
  bid_won: 'Bid Won',
  bid_lost: 'Bid Lost',
  passed: 'Passed',
  closed: 'Closed'
};

const state = {
  counties: [],
  properties: [],
  currentPropertyId: null,
  currentCountyId: null
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const body = await res.json(); if (body.error) msg = body.error; } catch (e) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function money(n) {
  if (n === null || n === undefined || n === '') return '—';
  return '$' + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

// ---------------- Tabs ----------------

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  if (name === 'dashboard') loadDashboard();
  if (name === 'properties') loadProperties();
  if (name === 'counties') loadCounties(true);
  if (name === 'routine') loadRoutine();
  if (name === 'settings') loadLetterTemplate();
}

document.querySelectorAll('.modal-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchModalTab(btn.dataset.mtab));
});

function switchModalTab(name) {
  document.querySelectorAll('.modal-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.mtab === name));
  document.querySelectorAll('.mtab-panel').forEach(p => p.classList.toggle('active', p.dataset.mpanel === name));
}

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModals());
});

function closeModals() {
  document.getElementById('propertyModal').classList.add('hidden');
  document.getElementById('countyModal').classList.add('hidden');
}

// ---------------- Dashboard ----------------

async function loadDashboard() {
  const data = await api('/api/dashboard');
  const grid = document.getElementById('statGrid');
  grid.innerHTML = '';
  const tiles = [
    ['Total Properties', data.totalProperties],
    ['Watching', data.byStatus.watching || 0],
    ['Auction Scheduled', data.byStatus.auction_scheduled || 0],
    ['Bid Won', data.byStatus.bid_won || 0],
    ['Counties Tracked', data.countyCount],
    ['Est. Potential Equity', money(data.totalPotentialEquity)]
  ];
  tiles.forEach(([label, value]) => {
    grid.appendChild(el(`<div class="stat-tile"><div class="label">${label}</div><div class="value">${value}</div></div>`));
  });

  const tbody = document.querySelector('#upcomingTable tbody');
  tbody.innerHTML = '';
  document.getElementById('upcomingEmpty').classList.toggle('hidden', data.upcomingAuctions.length > 0);
  data.upcomingAuctions.forEach(p => {
    const tr = el(`<tr>
      <td>${p.owner || '—'}</td>
      <td>${p.address}</td>
      <td>${p.auctionDate}</td>
      <td><button class="btn small" data-id="${p.id}">Open</button></td>
    </tr>`);
    tr.addEventListener('click', () => openPropertyById(p.id));
    tbody.appendChild(tr);
  });
}

async function openPropertyById(id) {
  switchTab('properties');
  const property = await api(`/api/properties/${id}`);
  openPropertyModal(property);
}

// ---------------- Counties ----------------

async function loadCounties(renderTable) {
  state.counties = await api('/api/counties');
  const selects = [
    document.getElementById('filterCounty'),
    document.getElementById('importCounty'),
    document.querySelector('#propertyForm select[name="countyId"]')
  ];
  selects.forEach(sel => {
    const keep = sel.value;
    const placeholder = sel.querySelector('option').outerHTML;
    sel.innerHTML = placeholder + state.counties.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    sel.value = keep;
  });
  if (renderTable) renderCountiesTable();
}

function renderCountiesTable() {
  const tbody = document.querySelector('#countiesTable tbody');
  tbody.innerHTML = '';
  state.counties.forEach(c => {
    const tr = el(`<tr>
      <td>${c.name}</td>
      <td>${c.gisUrlTemplate || '—'}</td>
      <td>${c.taxOfficeUrl || '—'}</td>
      <td>${c.taxOfficeContact || '—'}</td>
      <td><button class="btn small" data-id="${c.id}">Edit</button></td>
    </tr>`);
    tr.addEventListener('click', () => openCountyModal(c));
    tbody.appendChild(tr);
  });
}

document.getElementById('btnAddCounty').addEventListener('click', () => openCountyModal(null));

function openCountyModal(county) {
  state.currentCountyId = county ? county.id : null;
  document.getElementById('countyModalTitle').textContent = county ? 'Edit County' : 'Add County';
  const form = document.getElementById('countyForm');
  form.reset();
  if (county) {
    form.name.value = county.name || '';
    form.gisUrlTemplate.value = county.gisUrlTemplate || '';
    form.taxOfficeUrl.value = county.taxOfficeUrl || '';
    form.taxOfficeContact.value = county.taxOfficeContact || '';
    form.notes.value = county.notes || '';
  }
  document.getElementById('btnDeleteCounty').classList.toggle('hidden', !county);
  document.getElementById('countyModal').classList.remove('hidden');
}

document.getElementById('countyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.name.value,
    gisUrlTemplate: form.gisUrlTemplate.value,
    taxOfficeUrl: form.taxOfficeUrl.value,
    taxOfficeContact: form.taxOfficeContact.value,
    notes: form.notes.value
  };
  if (state.currentCountyId) {
    await api(`/api/counties/${state.currentCountyId}`, { method: 'PUT', body: JSON.stringify(body) });
  } else {
    await api('/api/counties', { method: 'POST', body: JSON.stringify(body) });
  }
  closeModals();
  await loadCounties(true);
});

document.getElementById('btnDeleteCounty').addEventListener('click', async () => {
  if (!state.currentCountyId) return;
  if (!confirm('Delete this county? Properties referencing it will keep their data but lose the link.')) return;
  await api(`/api/counties/${state.currentCountyId}`, { method: 'DELETE' });
  closeModals();
  await loadCounties(true);
});

// ---------------- Properties ----------------

const statusSelectsToPopulate = ['#filterStatus', '#propertyForm select[name="status"]'];
statusSelectsToPopulate.forEach(sel => {
  const node = document.querySelector(sel);
  STATUSES.forEach(s => node.appendChild(el(`<option value="${s}">${STATUS_LABELS[s]}</option>`)));
});

document.getElementById('filterSearch').addEventListener('input', debounce(loadProperties, 300));
document.getElementById('filterCounty').addEventListener('change', loadProperties);
document.getElementById('filterStatus').addEventListener('change', loadProperties);

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function loadProperties() {
  const q = document.getElementById('filterSearch').value;
  const countyId = document.getElementById('filterCounty').value;
  const status = document.getElementById('filterStatus').value;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (countyId) params.set('countyId', countyId);
  if (status) params.set('status', status);
  state.properties = await api('/api/properties?' + params.toString());
  renderPropertiesTable();
}

function countyName(id) {
  const c = state.counties.find(c => c.id === id);
  return c ? c.name : '—';
}

function renderPropertiesTable() {
  const tbody = document.querySelector('#propertiesTable tbody');
  tbody.innerHTML = '';
  document.getElementById('propertiesEmpty').classList.toggle('hidden', state.properties.length > 0);
  state.properties.forEach(p => {
    const tr = el(`<tr>
      <td>${p.owner || '—'}</td>
      <td>${p.address}</td>
      <td>${countyName(p.countyId)}</td>
      <td>${p.parcelNumber || '—'}</td>
      <td>${money(p.taxesOwed)}</td>
      <td>${money(p.estimatedValue)} ${p.tooCloseToMarket ? '<span class="flag-warn" title="Less than 15% below market value">⚠</span>' : ''}</td>
      <td>${money(p.maxBid)}</td>
      <td>${p.auctionDate || '—'}</td>
      <td><span class="status-pill">${STATUS_LABELS[p.status] || p.status}</span></td>
      <td><button class="btn small" data-id="${p.id}">Open</button></td>
    </tr>`);
    tr.addEventListener('click', () => openPropertyModal(p));
    tbody.appendChild(tr);
  });
}

document.getElementById('btnAddProperty').addEventListener('click', () => openPropertyModal(null));

async function openPropertyModal(property) {
  state.currentPropertyId = property ? property.id : null;
  document.getElementById('propertyModalTitle').textContent = property ? (property.address || 'Property') : 'Add Property';
  switchModalTab('details');
  const form = document.getElementById('propertyForm');
  form.reset();
  if (property) {
    for (const [key, val] of Object.entries(property)) {
      const input = form.elements[key];
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = !!val;
      else input.value = val ?? '';
    }
  } else {
    form.status.value = 'watching';
  }
  document.getElementById('btnDeleteProperty').classList.toggle('hidden', !property);
  updateDealSummary();
  buildQuickLinks(property);
  document.getElementById('contactLog').innerHTML = '';
  document.getElementById('generatedLetter').value = '';
  if (property) await loadContacts(property.id);
  document.getElementById('propertyModal').classList.remove('hidden');
}

document.getElementById('propertyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const body = {};
  for (const [key, val] of fd.entries()) body[key] = val;
  body.titleSearchDone = form.elements['titleSearchDone'].checked;
  if (state.currentPropertyId) {
    await api(`/api/properties/${state.currentPropertyId}`, { method: 'PUT', body: JSON.stringify(body) });
  } else {
    await api('/api/properties', { method: 'POST', body: JSON.stringify(body) });
  }
  closeModals();
  await loadProperties();
  await loadDashboard();
});

document.getElementById('btnDeleteProperty').addEventListener('click', async () => {
  if (!state.currentPropertyId) return;
  if (!confirm('Delete this property and its contact log?')) return;
  await api(`/api/properties/${state.currentPropertyId}`, { method: 'DELETE' });
  closeModals();
  await loadProperties();
  await loadDashboard();
});

// Deal math live preview
['taxesOwed', 'estimatedValue', 'repairCost', 'profitCushion'].forEach(name => {
  document.querySelector(`#propertyForm [name="${name}"]`).addEventListener('input', updateDealSummary);
});

function updateDealSummary() {
  const form = document.getElementById('propertyForm');
  const estimatedValue = Number(form.estimatedValue.value) || 0;
  const repairCost = Number(form.repairCost.value) || 0;
  const profitCushion = Number(form.profitCushion.value) || 0;
  const taxesOwed = Number(form.taxesOwed.value) || 0;
  const maxBid = estimatedValue - repairCost - profitCushion;
  const margin = estimatedValue > 0 ? (estimatedValue - taxesOwed) / estimatedValue : null;
  const tooClose = margin !== null && margin < 0.15;
  document.getElementById('dealSummary').innerHTML = `
    <div class="row"><span>Estimated Market Value</span><span>${money(estimatedValue)}</span></div>
    <div class="row"><span>− Estimated Repair Cost</span><span>${money(repairCost)}</span></div>
    <div class="row"><span>− Desired Profit Cushion</span><span>${money(profitCushion)}</span></div>
    <div class="row total"><span>Maximum Bid</span><span>${money(maxBid)}</span></div>
    ${taxesOwed ? `<div class="row" style="margin-top:8px;"><span>Taxes Owed (min. bid proxy)</span><span>${money(taxesOwed)}${tooClose ? ' <span class="flag-warn">⚠ within 15% of market value — thin margin</span>' : ''}</span></div>` : ''}
  `;
}

// ---------------- Contacts / outreach ----------------

async function loadContacts(propertyId) {
  const contacts = await api(`/api/properties/${propertyId}/contacts`);
  renderContactLog(contacts);
}

function renderContactLog(contacts) {
  const list = document.getElementById('contactLog');
  list.innerHTML = '';
  contacts.forEach(c => {
    list.appendChild(el(`<li><div class="meta">${c.date} · ${c.method}</div>${c.outcome || ''}</li>`));
  });
}

document.getElementById('btnLogContact').addEventListener('click', async () => {
  if (!state.currentPropertyId) { alert('Save the property first.'); return; }
  const date = document.getElementById('contactDate').value || new Date().toISOString().slice(0, 10);
  const method = document.getElementById('contactMethod').value;
  const outcome = document.getElementById('contactNotes').value;
  await api(`/api/properties/${state.currentPropertyId}/contacts`, {
    method: 'POST',
    body: JSON.stringify({ date, method, outcome })
  });
  document.getElementById('contactNotes').value = '';
  await loadContacts(state.currentPropertyId);
});

document.getElementById('btnGenLetter').addEventListener('click', async () => {
  if (!state.currentPropertyId) { alert('Save the property first.'); return; }
  const { letter } = await api(`/api/properties/${state.currentPropertyId}/letter`);
  document.getElementById('generatedLetter').value = letter;
});

document.getElementById('btnCopyLetter').addEventListener('click', () => {
  const ta = document.getElementById('generatedLetter');
  ta.select();
  document.execCommand('copy');
});

// ---------------- Quick links ----------------

function buildQuickLinks(property) {
  const wrap = document.getElementById('quickLinks');
  wrap.innerHTML = '';
  if (!property || !property.address) {
    wrap.innerHTML = '<p class="hint">Save the property with an address to generate links.</p>';
    return;
  }
  const addr = encodeURIComponent(property.address);
  const links = [
    ['Google Maps / Street View', `https://www.google.com/maps/search/?api=1&query=${addr}`],
    ['Zillow', `https://www.zillow.com/homes/${addr}_rb/`],
    ['Redfin', `https://www.redfin.com/search?location=${addr}`],
    ['Realtor.com', `https://www.realtor.com/realestateandhomes-search/${addr}`]
  ];
  const county = state.counties.find(c => c.id === property.countyId);
  if (county && county.gisUrlTemplate) {
    const gisUrl = county.gisUrlTemplate
      .replace('{parcel}', encodeURIComponent(property.parcelNumber || ''))
      .replace('{address}', addr);
    links.push([`${county.name} GIS`, gisUrl]);
  }
  if (county && county.taxOfficeUrl) {
    links.push([`${county.name} Tax Office`, county.taxOfficeUrl]);
  }
  links.forEach(([label, url]) => {
    wrap.appendChild(el(`<a href="${url}" target="_blank" rel="noopener">${label} ↗</a>`));
  });
}

// ---------------- Import ----------------

let lastParse = null;

document.getElementById('btnParseImport').addEventListener('click', async () => {
  const text = document.getElementById('importText').value;
  if (!text.trim()) { alert('Paste a list first.'); return; }
  const parsed = await api('/api/import/parse', { method: 'POST', body: JSON.stringify({ text }) });
  lastParse = parsed;
  renderImportPreview(parsed);
});

const IMPORT_FIELDS = ['', 'owner', 'address', 'parcelNumber', 'taxesOwed', 'estimatedValue', 'auctionDate', 'notes', 'status'];
const IMPORT_FIELD_LABELS = {
  '': '(ignore column)', owner: 'Owner', address: 'Address', parcelNumber: 'Parcel Number',
  taxesOwed: 'Taxes Owed', estimatedValue: 'Estimated Value', auctionDate: 'Auction Date',
  notes: 'Notes', status: 'Status'
};

function renderImportPreview(parsed) {
  document.getElementById('importPreviewWrap').classList.remove('hidden');
  const mapWrap = document.getElementById('mappingRow');
  mapWrap.innerHTML = '';
  parsed.headers.forEach((h, idx) => {
    const item = el(`<div class="mapping-item">
      <div class="header-name">${h || '(column ' + (idx + 1) + ')'}</div>
      <select data-idx="${idx}">${IMPORT_FIELDS.map(f => `<option value="${f}">${IMPORT_FIELD_LABELS[f]}</option>`).join('')}</select>
    </div>`);
    item.querySelector('select').value = parsed.mapping[idx] || '';
    item.querySelector('select').addEventListener('change', (e) => {
      parsed.mapping[idx] = e.target.value || null;
    });
    mapWrap.appendChild(item);
  });

  const table = document.getElementById('importPreviewTable');
  table.querySelector('thead').innerHTML = `<tr>${parsed.headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
  const tbody = table.querySelector('tbody') || table.appendChild(document.createElement('tbody'));
  tbody.innerHTML = parsed.rows.slice(0, 25).map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('');
}

document.getElementById('btnCommitImport').addEventListener('click', async () => {
  if (!lastParse) return;
  const countyId = document.getElementById('importCounty').value || null;
  const result = await api('/api/import/commit', {
    method: 'POST',
    body: JSON.stringify({ countyId, headers: lastParse.headers, mapping: lastParse.mapping, rows: lastParse.rows })
  });
  alert(`Imported ${result.created} properties.`);
  document.getElementById('importText').value = '';
  document.getElementById('importPreviewWrap').classList.add('hidden');
  lastParse = null;
  switchTab('properties');
});

// ---------------- Weekly routine ----------------

async function loadRoutine() {
  const data = await api('/api/weekly-routine');
  const list = document.getElementById('routineList');
  list.innerHTML = '';
  data.steps.forEach((step, idx) => {
    const checked = !!data.checked[idx];
    const li = el(`<li class="${checked ? 'done' : ''}"><input type="checkbox" ${checked ? 'checked' : ''} data-idx="${idx}" /><span>${step}</span></li>`);
    li.querySelector('input').addEventListener('change', async (e) => {
      await api('/api/weekly-routine', { method: 'PUT', body: JSON.stringify({ index: idx, checked: e.target.checked }) });
      li.classList.toggle('done', e.target.checked);
    });
    list.appendChild(li);
  });
}

// ---------------- Settings ----------------

async function loadLetterTemplate() {
  const { template } = await api('/api/letter-template');
  document.getElementById('letterTemplate').value = template;
}

document.getElementById('btnSaveLetterTemplate').addEventListener('click', async () => {
  const template = document.getElementById('letterTemplate').value;
  await api('/api/letter-template', { method: 'PUT', body: JSON.stringify({ template }) });
  const note = document.getElementById('letterSaveNote');
  note.textContent = 'Saved.';
  setTimeout(() => { note.textContent = ''; }, 2000);
});

// ---------------- Init ----------------

(async function init() {
  await loadCounties(false);
  await loadDashboard();
})();
