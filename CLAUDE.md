# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

PayPilot AI is a dual-deployment AI phone agent for outbound sales and collections calls. It has no build step — the frontend is a single monolithic `index.html` and the backend is plain Node.js.

## Running the App

```bash
# Install dependencies (root — Vercel serverless functions)
npm install

# Install Railway server dependencies
cd railway && npm install

# Start the Railway WebSocket server locally
npm start           # runs node railway/server.js
# or
node railway/server.js
```

There is no test suite and no linter configured.

**Health check:** `GET /health` returns `{ ok: true, activeCalls: N }`.  
**API connectivity test:** `GET /test` pings OpenAI and ElevenLabs and reports results.

## Deployment Architecture

Two separate services run in production:

| Layer | Host | Entry point |
|---|---|---|
| Frontend + serverless API | Vercel | `index.html` + `api/*.js` |
| Real-time WebSocket bridge | Railway | `railway/server.js` |

`vercel.json` disables HTML caching. The Railway server is a standalone Express + `ws` server — it is **not** part of the Vercel project.

## Two Call Modes

This is the most important architectural detail. There are two distinct calling implementations that co-exist:

### 1. TwiML Mode (Vercel, stateless)
Used by the "AI Auto-Caller" flow. Conversation state is carried entirely in the URL as a base64url-encoded JSON array (the `h` query param), capped at ~6 KB.

Flow: `api/ai-call.js` → Twilio dials out → `api/ai-twiml.js` (generates opening greeting + `<Gather>`) → Twilio posts speech to `api/ai-respond.js` → repeats until GPT-4o appends `[END]` or uses a closing phrase. TTS voice: `Polly.Joanna-Neural`.

The `[END]` signal and a list of closing phrases in `ai-respond.js:88-91` trigger a `<Hangup/>` response instead of another `<Gather>`.

### 2. Streaming Mode (Railway, real-time)
Used for the real-time dashboard experience. Twilio sends a Media Stream (mulaw 8 kHz audio) via WebSocket to `/twilio`. The server pipes audio to Deepgram for STT, sends the transcript to OpenAI GPT-4o, gets TTS from ElevenLabs (PCM16 16 kHz), then converts and streams mulaw back to Twilio.

The browser connects to `/browser?callSid=XX` to receive live transcript and AI response events as JSON messages.

The custom `pcm16ToMulaw()` function in `railway/server.js:276` downsamples PCM16 16 kHz → mulaw 8 kHz (2:1 downsample + ITU G.711 encoding) because Twilio Media Streams use mulaw 8 kHz.

Session state lives in the `sessions` Map keyed by `callSid`.

## Serverless API Files (`api/`)

| File | Method | Purpose |
|---|---|---|
| `ai-call.js` | POST | Initiates Twilio outbound call; points TwiML URL at Vercel |
| `ai-twiml.js` | GET | Returns opening TwiML `<Gather>` with AI-generated greeting |
| `ai-respond.js` | POST | Twilio webhook: processes `SpeechResult`, generates reply, decides hangup |
| `call-status.js` | GET | Fetches Twilio call status; `?type=speech&sid=XX` reads `/tmp/speech_*.json` |
| `end-call.js` | POST | Sets Twilio call status to `completed` |
| `twilio-speak.js` | POST | Injects TwiML into a live call for multi-language speech |
| `generate-response.js` | POST | Generic OpenAI proxy used by the AI Assist feature in the UI |
| `deepgram-token.js` | GET | Returns `DEEPGRAM_API_KEY` to the browser for client-side transcription |
| `search-company.js` | GET | Google Places Text Search + Place Details (top 5 results with phone/website) |
| `send-agreement.js` | POST | Sends DocuSign link via Resend email from `info@paypilotai.live` |
| `create-checkout.js` | POST | Creates Stripe Checkout session (keeps secret key server-side) |

Some files use `module.exports` (CommonJS) and some use `export default` (ESM) — Vercel handles both.

## Frontend (`index.html`)

A single-file SPA (~5 300 lines). All CSS is in `<style>`, all JS is in `<script>` at the bottom. Pages are `<section class="page">` elements toggled by `showPage()`. The app sections are: `dashboard`, `aicaller`, `assist`, `contacts`, `scripts`, `analytics`, `settings`, `billing`, `compliance`, `guide`, plus `#home` (marketing) and `#auth` (login).

Key JS globals: `currentPlan`, `isLiveUser`, `callActive`, `lastGeneratedText`, `planConfigs` (feature flags per plan), `smartReplies` (canned objection responses).

Login is checked in `loginDemo()` against hardcoded master credentials and a `TESTER_ACCOUNTS` array. Demo users hit `DEMO_RESPONSE_LIMIT = 3` before being prompted to upgrade.

The Stripe price IDs are hardcoded in `api/create-checkout.js`: `starter: price_1TQdvP84nVx3JlYAn5pAbYAb`, `pro: price_1TQdx284nVx3JlYAHl6dGlci`.

## Environment Variables

| Variable | Used by | Notes |
|---|---|---|
| `OPENAI_API_KEY` | Both | GPT-4o, `max_tokens: 120` (Railway), `70` (TwiML) |
| `TWILIO_ACCOUNT_SID` | Both | |
| `TWILIO_AUTH_TOKEN` | Both | Also used to verify `X-Twilio-Signature` on inbound webhooks (`lib/twilioAuth.js`) |
| `TWILIO_PHONE_NUMBER` | `ai-call.js` | |
| `DEEPGRAM_API_KEY` | Railway + `deepgram-token.js` | |
| `ELEVENLABS_API_KEY` | Railway | |
| `ELEVENLABS_VOICE_ID` | Railway | Default: `EXAVITQu4vr4xnSDxMaL` |
| `STRIPE_SECRET_KEY` | `create-checkout.js` | Never sent to browser |
| `GOOGLE_PLACES_KEY` | `search-company.js` | |
| `RESEND_API_KEY` | `send-agreement.js` | |
| `AI_SYSTEM_PROMPT` | Railway only | Overrides default collections agent prompt |
| `PORT` | Railway | Default `3000` |
| `FORWARD_TO_NUMBER` | `ai-twiml.js` | Real phone number inbound calls forward to (E.164, e.g. `+15551234567`); no attachment support without it |
| `AUTH_SECRET` | Both | **Required for login to work at all.** Random secret string used to sign session tokens (`lib/sessionAuth.js`). Generate one with e.g. `openssl rand -hex 32` |
| `MASTER_EMAIL` / `MASTER_PASS` | `call-status.js` (login) | Your real login credentials — no longer hardcoded in `index.html` |
| `TESTER_ACCOUNTS_JSON` | `call-status.js` (login) | JSON array of `{email, password, plan}` for tester accounts, e.g. `[{"email":"user1@paypilotai.live","password":"...","plan":"pro"}]` |
| `INTERNAL_API_SECRET` | Both | Shared secret for server-to-server calls (Railway → Vercel's `send-agreement.js`) that have no user session to present. Generate with `openssl rand -hex 32` |
| `SKIP_TWILIO_SIGNATURE_CHECK` | Both | Emergency kill-switch — set to `true` to bypass Twilio signature verification if it ever misfires in production |

Local dev uses `.env.local` (not committed — the committed version has a placeholder key).
