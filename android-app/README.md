# PayPilot AI — Android app

A Capacitor shell that loads the live site (`https://paypilotai.live`) inside a native Android app. Because it loads the live site, every Vercel deploy updates the app instantly — no Play Store update needed for web changes.

## What's native

- **Mic / live transcription** — Android's on-device speech recognizer replaces the browser speech API (which Android webviews don't support). See `../native-bridge.js`.
- **Speak button** — Android text-to-speech.
- **Billing** — purchases stay on the website. In the app, subscribe and billing-portal buttons are hidden and a note points users to the website. This keeps the app clear of Google Play Billing requirements.
- **First launch** opens on the login screen.

`native-bridge.js` only activates when the user agent contains `PayPilotAndroid` (set in `capacitor.config.json`), so the website is unaffected in normal browsers.

## Limits

- Android does not let apps hear audio from regular cellular phone calls. The app hears the room through the mic: speakerphone, in-person, or a laptop call playing out loud. Using the phone as a second screen during laptop calls works well.
- Android's recognizer pauses after silence and restarts automatically; some phones play a short tone each time it restarts.

## Getting the app

Every push to `android-app/**` runs the **Android app** GitHub Action:

1. GitHub → **Actions** → latest **Android app** run → **Artifacts** → `PayPilotAI-test-apk`.
2. Unzip, copy `app-debug.apk` to an Android phone, open it, and allow "Install unknown apps" when asked.

## Publishing to Google Play

1. Create a Google Play developer account ($25 one-time).
2. Create an upload key (once, keep it safe — losing it complicates updates):
   ```bash
   keytool -genkey -v -keystore paypilot-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias paypilot
   base64 -w0 paypilot-upload.jks   # copy the output
   ```
3. In GitHub → Settings → Secrets and variables → Actions, add:
   `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`paypilot`), `ANDROID_KEY_PASSWORD`.
4. Re-run the workflow; it then also produces `PayPilotAI-play-store-aab`. Upload that `.aab` in the Play Console.
5. Play Console needs: a privacy policy URL, the microphone permission explanation (live call coaching), screenshots, and a login for the reviewer (a tester account).

## Local development (optional)

Requires Node 22+, JDK 21 and Android Studio.

```bash
cd android-app
npm install
npx cap sync android
npx cap open android      # opens in Android Studio, press Run
```

Icons and splash screens come from `assets/`; regenerate with `npm run assets`.
