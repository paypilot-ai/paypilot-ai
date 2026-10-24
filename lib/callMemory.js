// Brandy remembers past conversations with the same person.
//
// Before an outbound call, look up earlier calls this same PayPilot account
// made to this same number (matched on the pp_account and pp_to variables
// that api/ai-call.js puts on every call) and summarize them for her prompt.
// Only the same account's calls are used, so one customer's conversations
// never leak into another customer's calls. Best effort: if the lookup is
// slow or fails, the call goes ahead without memory.
const EL_HOSTS = ['https://api.us.elevenlabs.io', 'https://api.elevenlabs.io'];
const AGENT_ID = () => (process.env.ELEVENLABS_AGENT_ID || 'agent_8701m5jkzbzfe8ybw4k8qx3vpypk').trim();
const BUDGET_MS = 2500;
const MAX_CALLS = 3;
const LOOKBACK_SECS = 180 * 24 * 3600;

const val = (dc, k) => {
  const v = dc && dc[k] && dc[k].value;
  return v === null || v === undefined || v === '' ? '' : String(v);
};

function ago(unixSecs) {
  const days = Math.round((Date.now() / 1000 - unixSecs) / 86400);
  if (days <= 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `about ${Math.round(days / 7)} weeks ago`;
  return `about ${Math.round(days / 30)} months ago`;
}

async function getJson(url, key, signal) {
  const r = await fetch(url, { headers: { 'xi-api-key': key }, signal });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// Returns a short text block for the prompt, or '' if there's no history.
async function pastConversations({ account, toNumber }) {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key || !account || !toNumber) return '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BUDGET_MS);
  try {
    const q = new URLSearchParams({
      agent_id: AGENT_ID(),
      page_size: '6',
      call_start_after_unix: String(Math.floor(Date.now() / 1000) - LOOKBACK_SECS),
    });
    q.append('dynamic_variable_params', `pp_to:eq:${toNumber}`);
    q.append('dynamic_variable_params', `pp_account:eq:${account}`);
    for (const host of EL_HOSTS) {
      try {
        const page = await getJson(`${host}/v1/convai/conversations?${q}`, key, ctrl.signal);
        const done = (page.conversations || []).filter((c) => c.status === 'done' && (c.call_duration_secs || 0) >= 15).slice(0, MAX_CALLS);
        if (!done.length) return '';
        const details = await Promise.all(done.map((c) =>
          getJson(`${host}/v1/convai/conversations/${encodeURIComponent(c.conversation_id)}`, key, ctrl.signal).catch(() => null)));
        const lines = [];
        for (const d of details) {
          if (!d) continue;
          const v = (d.conversation_initiation_client_data && d.conversation_initiation_client_data.dynamic_variables) || {};
          // Double-check rather than trust the filter alone.
          if (v.pp_account !== account || v.pp_to !== toNumber) continue;
          const dc = (d.analysis && d.analysis.data_collection_results) || {};
          const when = d.metadata && d.metadata.start_time_unix_secs ? ago(d.metadata.start_time_unix_secs) : 'before';
          const parts = [
            (d.analysis && d.analysis.transcript_summary) || '',
            val(dc, 'lead_interest') ? `Interest: ${val(dc, 'lead_interest')}.` : '',
            val(dc, 'lead_callback') ? `Best time to call back: ${val(dc, 'lead_callback')}.` : '',
            val(dc, 'lead_notes') ? `Notes: ${val(dc, 'lead_notes')}` : '',
            val(dc, 'lead_email') ? `Email on file: ${val(dc, 'lead_email')}.` : '',
          ].filter(Boolean).join(' ');
          if (parts) lines.push(`- ${when}: ${parts.slice(0, 700)}`);
        }
        return lines.join('\n');
      } catch (e) {
        if (ctrl.signal.aborted) return '';
      }
    }
    return '';
  } catch (_) {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pastConversations };
