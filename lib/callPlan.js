// Turns whatever a customer typed into "Call Context & Objective" into a clear
// plan Brandy can follow. People write this box in every style: word-for-word
// scripts, bullet notes, one sentence, training notes with stage directions,
// voicemail scripts, objection branches, [placeholders], a rep's own name...
// Before the call, an LLM reads it once and writes a clean, ordered plan.
//
// The plan is built per call (cached for repeat calls with the same notes,
// e.g. the Auto-Dialer) and is never saved anywhere. If it fails or is slow,
// the call goes ahead with the original notes, as before.
const crypto = require('crypto');

const cache = new Map();           // sha1(notes|company|contact) -> plan
const MAX_CACHE = 200;
const TIMEOUT_MS = 12000;

const SYSTEM = `You prepare a phone call plan for Brandy, an AI caller making a live outbound call on behalf of a business. The business typed notes about the call. Notes come in every style: a word-for-word script, rough bullets, one sentence, training material, or a mix. Read them the way an experienced sales manager would, work out what the business actually wants, and write a clear plan Brandy can follow.

Rules:
- Use only what's in the notes. Never invent facts, prices, numbers, policies, names or promises. Copy every number, fee, rate, timeframe, phone number and name exactly.
- Brandy is the caller. If the notes name a human rep as the caller (for example "this is Sean with..."), Brandy says "Brandy" instead.
- Placeholders like [Client], [Name] or ____ that aren't filled in: tell Brandy what to say instead (for example "one of your customers") or to skip it.
- Drop stage directions and formatting notes ("long pause", "always", headings) but keep what they mean (a pause after an offer means: ask, then wait).
- Internal training notes or acronyms (for example "TAG stands for Tell, Ask, Give") become plain behavior instructions.
- Keep every piece of information the notes say to collect or verify (PIN, account number, address, phone, email, etc.) as its own required step, in the order given.
- Keep conditional branches ("if they push back on the fee...", "if they decline...", "if approved...") as IF lines with the exact response or concession, including any limits (lowest rate, max coverage).
- Closing or wrap-up talk goes under CLOSE.
- VOICEMAIL MESSAGE: write the exact words Brandy will leave if she reaches voicemail, in warm natural spoken English, under 45 words: her name and the business she's calling for, one plain sentence on why, the callback number if one is known (from the notes' voicemail script or the "Callback number" given), said once and then repeated, and then the business's website if one is known (from the notes or the "Website" given), said the easy way ("pay pilot A I dot live"). Under 55 words when a website is included. If the notes have a voicemail script, base it on that but use Brandy's name and the right callback number. No prices. Write numbers so they're easy to say ("980, 920, 2173").
- Decide the call type: FOLLOW-UP (about something the person requested, started, or already knows about) or COLD (they haven't heard of it). Say which, in one line, with the reason.
- Brandy is a skilled salesperson with her own style. Describe WHAT she needs to accomplish and the facts she can use, as short notes, never as sentences for her to say. Strip marketing language down to plain facts. Only keep exact wording where it must be said a specific way (legal or compliance language, a required disclosure).
- Write in short plain lines, no markdown symbols other than "-" bullets and the section labels below. Keep it under 450 words.

Output exactly these sections, leaving out any that don't apply:
CALL TYPE:
GOAL:
PURPOSE (the idea in a few words, not a line to say):
STEPS (in order, one per turn):
INFO TO COLLECT OR VERIFY:
KEY FACTS:
IF THEY...:
CLOSE:
VOICEMAIL MESSAGE:
DON'T:`;

async function buildPlan({ notes, company, contact, callback, website }) {
  const key = (process.env.OPENAI_API_KEY || '').trim().replace(/^=+/, '');
  const text = String(notes || '').trim();
  if (!key || text.length < 40) return null;   // short notes are fine as they are

  const id = crypto.createHash('sha1').update(`${text}|${company}|${contact}|${callback || ''}|${website || ''}`).digest('hex');
  if (cache.has(id)) return cache.get(id);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Business: ${company || 'not given'}\nPerson being called: ${contact || 'not given'}\nCallback number for voicemails: ${callback || 'not given'}\nWebsite for voicemails: ${website || 'not given'}\n\nTHE BUSINESS'S NOTES:\n${text}` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const d = await r.json();
    const plan = String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
    if (plan.length < 40) return null;
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(id, plan);
    return plan;
  } catch (e) {
    console.error('[call-plan] skipped:', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The exact voicemail words from a plan, if it has them.
function voicemailFrom(plan) {
  const m = String(plan || '').match(/VOICEMAIL MESSAGE:\s*([\s\S]*?)(?:\n[A-Z][A-Z' .,()/-]{3,}:|$)/);
  if (!m) return '';
  return m[1].replace(/["“”]/g, '').replace(/^[-\s]+/, '').replace(/\s*\n+\s*-?\s*/g, ' ').trim().slice(0, 600);
}

module.exports = { buildPlan, voicemailFrom };
