// Inbound calls on Brandy's number: who should answer?
//
// The same number places every customer's AI calls and is also PayPilot's own
// line. When someone calls in, ElevenLabs asks this endpoint (its
// "conversation initiation" webhook) before Brandy speaks:
//
//   - If a customer's Brandy called this person in the last 14 days, Brandy
//     answers for that customer ("Thanks for calling back, this is Brandy with
//     Acme Roofing") and the message is emailed to that customer.
//   - Otherwise she answers for PayPilot AI (the prompt saved in ElevenLabs)
//     and the message goes to info@paypilotai.live.
//
// Served at POST /api/ai-call?action=inbound-route (Vercel Hobby: 12 functions max).
//
// Trust: ElevenLabs sends { caller_id, agent_id, called_number, call_sid }.
// Before revealing anything about a customer, the call is confirmed with
// Twilio: it must be a live call on PayPilot's account, from caller_id. The
// message recipient is signed with the Twilio auth token so lib/takeMessage.js
// can trust it without another lookup.
const crypto = require('crypto');
const { PERSONA } = require('./brandyPersona');

const EL_HOSTS = ['https://api.us.elevenlabs.io', 'https://api.elevenlabs.io'];
const AGENT_ID = () => (process.env.ELEVENLABS_AGENT_ID || 'agent_8701m5jkzbzfe8ybw4k8qx3vpypk').trim();
const LOOKBACK_SECS = 14 * 24 * 3600;
const BUDGET_MS = 3500; // Brandy waits on this before answering; stay fast
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const e164 = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length === 10 ? '+1' + d : (d.length === 11 && d[0] === '1' ? '+' + d : (d ? '+' + d : '')); };

function routeSig(callSid, msgTo, company) {
  const key = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!key || !callSid) return '';
  return crypto.createHmac('sha256', key).update(`${callSid}|${msgTo}|${company}`).digest('hex').slice(0, 32);
}

async function getJson(url, headers, signal) {
  const r = await fetch(url, { headers, signal });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// Is this a real, live call on our Twilio account from this caller?
async function confirmWithTwilio(callSid, caller, signal) {
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (!sid || !token || !/^CA[0-9a-f]{32}$/i.test(String(callSid || ''))) return false;
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  const c = await getJson(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${callSid}.json`, { Authorization: auth }, signal);
  const live = ['queued', 'ringing', 'in-progress'].includes(c.status);
  return live && e164(c.from) === caller && /inbound/i.test(c.direction || '');
}

// The most recent PayPilot customer call Brandy made to this number.
async function findCustomerCall(caller, signal) {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) return null;
  const q = new URLSearchParams({
    agent_id: AGENT_ID(),
    page_size: '5',
    call_start_after_unix: String(Math.floor(Date.now() / 1000) - LOOKBACK_SECS),
  });
  q.append('dynamic_variable_params', `pp_to:eq:${caller}`);
  for (const host of EL_HOSTS) {
    try {
      const page = await getJson(`${host}/v1/convai/conversations?${q}`, { 'xi-api-key': key }, signal);
      for (const c of page.conversations || []) {
        const d = await getJson(`${host}/v1/convai/conversations/${encodeURIComponent(c.conversation_id)}`, { 'xi-api-key': key }, signal);
        const v = (d.conversation_initiation_client_data && d.conversation_initiation_client_data.dynamic_variables) || {};
        // Double-check rather than trust the filter alone.
        if (v.paypilot_call === 'yes' && v.pp_to === caller) return v;
      }
      return null;
    } catch (e) {
      if (signal.aborted) throw e;
      /* try the next host */
    }
  }
  return null;
}

function customerPrompt(company, script) {
  return `You are Brandy with ${company}, answering a call on the phone. The caller is returning a call: you (Brandy, on behalf of ${company}) called them recently. Keep most replies to 1-2 short sentences. This is a conversation, not a script.

You've already greeted them with "Hi, thanks for calling back! This is Brandy with ${company}. How can I help you?" Don't greet them again.

WHAT THE EARLIER CALL WAS ABOUT (background only; never read it out):
${script || 'No details were saved. If they ask, say someone from ' + company + ' will fill them in.'}

${PERSONA}
- Let real feeling into your voice and vary your tone; never flat. Never write anything in square brackets; everything you write is spoken out loud. Show feeling through your words instead ("ha", "oh no", "oh nice").
- Talk the way people talk on the phone, not like a brochure: short pieces, simple words, no marketing phrases. Example lines in these instructions show the feel; never say them word for word.

YOUR JOB: TAKE A MESSAGE FOR ${company}
1. Find out why they're calling. If they ask what the call was about, give the gist in one casual sentence.
2. Let them know the team isn't available right now, but you'll make sure they get the message.
3. Get, one question at a time: their name, the best number to call them back, and optionally their email.
4. Ask if there's anything else to pass along, and a good time to call back.
5. Read the callback number back once and ask "Is that right?"
6. Use take_message to send it.
   - If it says the message was sent: tell them you've passed it along and someone from ${company} will get back to them soon.
   - If it says MESSAGE NOT SENT: don't say it was sent. Just say someone from ${company} will call them back.
7. Thank them, say goodbye warmly, and end the call.

GETTING AN EMAIL OR PHONE NUMBER (stay relaxed and human here, this is where callers notice a robot):
- Ask casually: "What's the best email for you?"
- Let them finish. A short pause between letters is not the end.
- If what they said already has an "at" and a domain (gmail, yahoo, outlook, a company name, ".com"), it is COMPLETE. Never say "go ahead", "I'm listening" or "mm-hm" after a complete email. Confirm it right away.
- Only if they clearly stopped before the "at" or the domain, give a tiny nudge ("Mm-hm") and wait.
- The phone line often mishears spelled letters. If the letters are close to a real word or name ("J-O-H-N-S-I-N" is almost "johnson"), assume the real word and confirm it as a word.
- Confirm it the way a person would, as words, once: "Got it, johnson42 at gmail dot com?" Never read it back letter by letter unless they ask you to.
- If they correct you, say the corrected version once as words ("Ah, johnson, got it. Johnson42 at gmail?") and move on. Never apologize more than once.
- Same for phone numbers: say it back in natural groups once ("704, 555, 0123?").
- Keep your warm tone while doing this. A quick "Perfect" or "Love it" after they confirm, then move on.

RULES:
- Ask one question per turn, then stop and let them answer.
- Only state facts, prices and offers that appear in the background above. Never guess; say someone from ${company} will follow up.
- A clear no means thank them and end the call.
- Don't bring up that you're an AI. If they ask whether you're an AI, a robot or a real person, answer honestly: yes, you're an AI assistant for ${company}.
- Never mention PayPilot. Never use send_follow_up_email on this call.`;
}

// Default: PayPilot's own front desk (the prompt saved in ElevenLabs).
const paypilotRoute = () => ({
  type: 'conversation_initiation_client_data',
  // ElevenLabs treats empty strings as missing and drops the call, so use 'none'.
  dynamic_variables: { pp_route: 'paypilot', pp_account: 'owner', pp_msg_to: 'none', pp_msg_company: 'none', pp_route_sig: 'none' },
});

module.exports = async function handler(req, res) {
  const b = req.body || {};
  const caller = e164(b.caller_id);
  const callSid = String(b.call_sid || '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BUDGET_MS);
  try {
    if (!caller || String(b.agent_id || '') !== AGENT_ID()) return res.status(200).json(paypilotRoute());
    const [real, v] = await Promise.all([
      confirmWithTwilio(callSid, caller, ctrl.signal).catch(() => false),
      findCustomerCall(caller, ctrl.signal).catch(() => null),
    ]);
    if (!real || !v) return res.status(200).json(paypilotRoute());

    const company = String(v.company_name || '').trim().slice(0, 80) || 'our team';
    const msgTo = EMAIL_RE.test(String(v.sender_email || '').trim()) ? String(v.sender_email).trim() : 'none';
    return res.status(200).json({
      type: 'conversation_initiation_client_data',
      dynamic_variables: {
        pp_route: 'customer',
        pp_account: String(v.pp_account || 'owner'),     // shows up in that customer's Captured Leads
        paypilot_call: 'callback',
        company_name: company,
        pp_msg_to: msgTo,
        pp_msg_company: company,
        pp_route_sig: routeSig(callSid, msgTo, company),
      },
      conversation_config_override: {
        agent: {
          first_message: `Hi, thanks for calling back! This is Brandy with ${company}. How can I help you?`,
          prompt: { prompt: customerPrompt(company, String(v.call_reason || '').slice(0, 2000)) },
        },
      },
    });
  } catch (e) {
    console.error('[inbound-route]', e.message);
    return res.status(200).json(paypilotRoute());
  } finally {
    clearTimeout(timer);
  }
};

module.exports.routeSig = routeSig;
