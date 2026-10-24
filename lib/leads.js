// Captured Leads: what people told Brandy on calls (name, email, phone,
// interest, callback time, notes), pulled from ElevenLabs' post-call analysis.
//
// Served at GET /api/ai-call?action=leads (kept out of api/ because the Vercel
// Hobby plan allows at most 12 functions). Each PayPilot account only sees
// calls it placed: api/ai-call.js tags every call with a pp_account dynamic
// variable, and this filters on it.
const { getBearerToken, verifyToken } = require('./sessionAuth');

const EL_HOSTS = ['https://api.us.elevenlabs.io', 'https://api.elevenlabs.io'];
const AGENT_ID = () => (process.env.ELEVENLABS_AGENT_ID || 'agent_8701m5jkzbzfe8ybw4k8qx3vpypk').trim();
const FIELDS = ['lead_name', 'lead_email', 'lead_phone', 'lead_interest', 'lead_callback', 'lead_notes', 'lead_details'];

// Same identity rule as api/ai-call.js uses when it tags a call.
function accountFor(req) {
  const t = verifyToken(getBearerToken(req));
  return t && t.sub ? String(t.sub) : 'owner';
}

async function elGet(path, key) {
  let last = null;
  for (const host of EL_HOSTS) {
    try {
      const r = await fetch(host + path, { headers: { 'xi-api-key': key } });
      if (r.ok) return await r.json();
      last = r.status;
    } catch (_) { /* try next host */ }
  }
  throw new Error('ElevenLabs lookup failed' + (last ? ` (${last})` : ''));
}

const val = (dc, k) => {
  const v = dc && dc[k] && dc[k].value;
  return v === null || v === undefined ? '' : String(v);
};

async function list(req, res) {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return res.status(500).json({ error: 'ElevenLabs is not set up.' });
  const account = accountFor(req);
  const q = new URLSearchParams({ agent_id: AGENT_ID(), page_size: '40' });
  q.append('dynamic_variable_params', `pp_account:eq:${account}`);
  try {
    const page = await elGet(`/v1/convai/conversations?${q}`, key);
    const convs = (page.conversations || []).filter((c) => c.status === 'done' || c.status === 'processing');
    const details = await Promise.all(convs.map((c) =>
      elGet(`/v1/convai/conversations/${encodeURIComponent(c.conversation_id)}`, key).catch(() => null)));
    const leads = details.filter(Boolean).map((d) => {
      const dc = (d.analysis && d.analysis.data_collection_results) || {};
      const vars = (d.conversation_initiation_client_data && d.conversation_initiation_client_data.dynamic_variables) || {};
      const row = {
        id: d.conversation_id,
        date: d.metadata && d.metadata.start_time_unix_secs ? new Date(d.metadata.start_time_unix_secs * 1000).toISOString() : '',
        duration_secs: (d.metadata && d.metadata.call_duration_secs) || 0,
        called_number: (d.metadata && d.metadata.phone_call && d.metadata.phone_call.external_number) || '',
        direction: (d.metadata && d.metadata.phone_call && d.metadata.phone_call.direction) || '',
        has_audio: d.has_audio !== false,
        company: vars.company_name || '',
        contact: vars.customer_name || '',
        summary: (d.analysis && d.analysis.transcript_summary) || '',
        processing: d.status !== 'done',
      };
      for (const f of FIELDS) row[f.replace('lead_', '')] = val(dc, f);
      return row;
    }).sort((a, b) => (a.date < b.date ? 1 : -1));
    return res.status(200).json({ leads });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// POST ?action=leads-delete  { ids: [conversation_id, ...] }
// Permanently deletes those calls (lead details, transcript and recording)
// from ElevenLabs. Only calls this account placed can be deleted.
async function remove(req, res) {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return res.status(500).json({ error: 'ElevenLabs is not set up.' });
  const account = accountFor(req);
  const ids = [...new Set(((req.body && req.body.ids) || []).map(String))]
    .filter((id) => /^conv_[A-Za-z0-9]+$/.test(id)).slice(0, 50);
  if (!ids.length) return res.status(400).json({ error: 'No leads selected.' });

  const results = await Promise.all(ids.map(async (id) => {
    try {
      const d = await elGet(`/v1/convai/conversations/${encodeURIComponent(id)}`, key);
      const vars = (d.conversation_initiation_client_data && d.conversation_initiation_client_data.dynamic_variables) || {};
      if (d.agent_id !== AGENT_ID() || String(vars.pp_account || '') !== account) return { id, ok: false, error: 'not yours' };
      for (const host of EL_HOSTS) {
        const r = await fetch(`${host}/v1/convai/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'xi-api-key': key } }).catch(() => null);
        if (r && (r.ok || r.status === 404)) return { id, ok: true };
      }
      return { id, ok: false, error: 'delete failed' };
    } catch (e) {
      return { id, ok: false, error: e.message };
    }
  }));
  const deleted = results.filter((r) => r.ok).map((r) => r.id);
  return res.status(200).json({ deleted, failed: results.filter((r) => !r.ok) });
}

// GET ?action=call-audio&id=conv_...  The call's recording (Call History).
// Only for calls this account placed or received.
async function audio(req, res) {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  const id = String((req.query && req.query.id) || '');
  if (!key) return res.status(500).json({ error: 'ElevenLabs is not set up.' });
  if (!/^conv_[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ error: 'Bad call id.' });
  try {
    const d = await elGet(`/v1/convai/conversations/${encodeURIComponent(id)}`, key);
    const vars = (d.conversation_initiation_client_data && d.conversation_initiation_client_data.dynamic_variables) || {};
    if (d.agent_id !== AGENT_ID() || String(vars.pp_account || '') !== accountFor(req)) return res.status(404).json({ error: 'Not found.' });
    for (const host of EL_HOSTS) {
      const r = await fetch(`${host}/v1/convai/conversations/${encodeURIComponent(id)}/audio`, { headers: { 'xi-api-key': key } }).catch(() => null);
      if (r && r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/mpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        return res.status(200).send(buf);
      }
    }
    return res.status(404).json({ error: 'No recording for this call.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { list, remove, audio, accountFor };
