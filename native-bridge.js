/*
 * PayPilot AI — native app bridge.
 *
 * Loaded by index.html on every page view, but does nothing unless the page is
 * running inside the PayPilot Android app (the Capacitor shell in android-app/,
 * which appends "PayPilotAndroid" to the user agent). In a normal browser this
 * file returns immediately and changes nothing.
 *
 * Inside the app it:
 *   1. Replaces the browser Web Speech API (SpeechRecognition), which Android's
 *      WebView doesn't support, with Android's on-device speech recognizer via
 *      the @capacitor-community/speech-recognition plugin. The shim mimics the
 *      browser API (continuous/interimResults/lang, onresult/onerror/onend,
 *      start/stop), so startDeepgram()/stopDeepgram() in index.html work as-is.
 *   2. Replaces speechSynthesis with Android text-to-speech via the
 *      @capacitor-community/text-to-speech plugin, so "Speak" buttons work.
 *   3. Keeps purchasing on the website: subscribe and billing-portal buttons
 *      are hidden in the app (Google Play requires Play Billing for in-app
 *      purchases of digital subscriptions; customers subscribe on the website
 *      and simply log in here).
 *   4. Opens the app on the login screen instead of the marketing homepage.
 */
(function () {
  'use strict';

  var IS_APP = /PayPilotAndroid/.test(navigator.userAgent);
  if (!IS_APP) return;

  window.PAYPILOT_NATIVE_APP = true;
  document.documentElement.classList.add('pp-native-app');

  function plugin(name) {
    var cap = window.Capacitor;
    return cap && cap.Plugins ? cap.Plugins[name] : null;
  }

  // ------------------------------------------------------------------
  // 1. SpeechRecognition shim
  // ------------------------------------------------------------------
  function NativeSpeechRecognition() {
    this.continuous = false;
    this.interimResults = false;
    this.lang = 'en-US';
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.onstart = null;
    this._running = false;
    this._handles = [];
    this._lastText = '';
    this._ended = true;
    this._poll = null;
    this._session = 0;
  }

  NativeSpeechRecognition.prototype._emit = function (name, payload) {
    var fn = this['on' + name];
    if (typeof fn === 'function') {
      try { fn.call(this, payload); } catch (e) { console.error('[native-bridge]', e); }
    }
  };

  NativeSpeechRecognition.prototype._emitResult = function (text, isFinal) {
    if (!text) return;
    if (!isFinal && !this.interimResults) return;
    var alt = { transcript: text, confidence: isFinal ? 0.9 : 0 };
    var result = [alt];
    result.isFinal = isFinal;
    result.item = function (i) { return result[i]; };
    var results = [result];
    results.item = function (i) { return results[i]; };
    this._emit('result', { resultIndex: 0, results: results });
  };

  // One recognizer "session" ends when Android decides the speaker paused.
  // Promote the last partial transcript to a final result, then fire onend —
  // index.html's onend handler restarts listening while the mic is still on.
  NativeSpeechRecognition.prototype._finish = function (session) {
    if (session !== this._session || this._ended) return;
    this._ended = true;
    clearInterval(this._poll);
    var text = this._lastText;
    this._lastText = '';
    if (text) this._emitResult(text, true);
    this._detach();
    this._running = false;
    this._emit('end', {});
  };

  NativeSpeechRecognition.prototype._detach = function () {
    this._handles.forEach(function (h) {
      Promise.resolve(h).then(function (handle) { if (handle && handle.remove) handle.remove(); });
    });
    this._handles = [];
  };

  NativeSpeechRecognition.prototype.start = function () {
    var self = this;
    var SR = plugin('SpeechRecognition');
    if (!SR) {
      setTimeout(function () {
        self._emit('error', { error: 'service-not-allowed', message: 'Speech plugin unavailable' });
        self._emit('end', {});
      }, 0);
      return;
    }
    if (this._running) throw new Error('InvalidStateError: recognition already started');
    this._running = true;
    this._ended = false;
    this._lastText = '';
    var session = ++this._session;

    SR.requestPermissions().then(function (perm) {
      if (session !== self._session) return;
      if (perm && perm.speechRecognition && perm.speechRecognition !== 'granted') {
        self._emit('error', { error: 'not-allowed' });
        self._finish(session);
        return;
      }

      self._handles.push(SR.addListener('partialResults', function (data) {
        if (session !== self._session) return;
        var text = data && data.matches && data.matches[0];
        if (text) {
          self._lastText = text;
          self._emitResult(text, false);
        }
      }));
      self._handles.push(SR.addListener('listeningState', function (data) {
        if (session !== self._session) return;
        // Android sends "stopped" just before the final transcript arrives;
        // give it a moment to land before closing the session.
        if (data && data.status === 'stopped') setTimeout(function () { self._finish(session); }, 700);
      }));

      self._emit('start', {});
      var startedAt = Date.now();

      // Safety net: some recognizer errors (no match, timeout) end the session
      // without a "stopped" event. Poll and close it out if so.
      self._poll = setInterval(function () {
        if (Date.now() - startedAt < 1500) return;
        SR.isListening().then(function (r) {
          if (r && r.listening === false) setTimeout(function () { self._finish(session); }, 700);
        }).catch(function () {});
      }, 1000);

      return SR.start({
        language: self.lang || 'en-US',
        maxResults: 1,
        partialResults: true,
        popup: false
      });
    }).catch(function (err) {
      if (session !== self._session) return;
      var msg = String((err && err.message) || err || '');
      var code = /permission|denied/i.test(msg) ? 'not-allowed'
        : /match|timeout|speech/i.test(msg) ? 'no-speech'
        : 'audio-capture';
      self._emit('error', { error: code, message: msg });
      setTimeout(function () { self._finish(session); }, 300);
    });
  };

  NativeSpeechRecognition.prototype.stop = function () {
    var SR = plugin('SpeechRecognition');
    var session = this._session;
    if (SR) SR.stop().catch(function () {});
    var self = this;
    setTimeout(function () { self._finish(session); }, 300);
  };

  NativeSpeechRecognition.prototype.abort = function () {
    this._lastText = '';
    this.stop();
  };

  window.SpeechRecognition = NativeSpeechRecognition;
  window.webkitSpeechRecognition = NativeSpeechRecognition;

  // ------------------------------------------------------------------
  // 2. speechSynthesis shim
  // ------------------------------------------------------------------
  if (typeof window.SpeechSynthesisUtterance !== 'function') {
    window.SpeechSynthesisUtterance = function (text) {
      this.text = text || '';
      this.lang = 'en-US';
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.onstart = this.onend = this.onerror = null;
    };
  }

  var synth = {
    speaking: false,
    pending: false,
    paused: false,
    _current: null,
    getVoices: function () { return []; },
    pause: function () {},
    resume: function () {},
    cancel: function () {
      var TTS = plugin('TextToSpeech');
      var u = this._current;
      this._current = null;
      this.speaking = false;
      if (TTS) TTS.stop().catch(function () {});
      if (u && typeof u.onend === 'function') { try { u.onend({}); } catch (e) {} }
    },
    speak: function (u) {
      var TTS = plugin('TextToSpeech');
      var self = this;
      if (!TTS || !u) return;
      if (this.speaking) this.cancel();
      this._current = u;
      this.speaking = true;
      if (typeof u.onstart === 'function') { try { u.onstart({}); } catch (e) {} }
      TTS.speak({
        text: String(u.text || ''),
        lang: u.lang || 'en-US',
        rate: typeof u.rate === 'number' ? u.rate : 1,
        pitch: typeof u.pitch === 'number' ? u.pitch : 1,
        volume: typeof u.volume === 'number' ? u.volume : 1
      }).then(function () {
        if (self._current !== u) return;
        self._current = null;
        self.speaking = false;
        if (typeof u.onend === 'function') { try { u.onend({}); } catch (e) {} }
      }).catch(function (err) {
        if (self._current !== u) return;
        self._current = null;
        self.speaking = false;
        if (typeof u.onerror === 'function') { try { u.onerror({ error: String(err) }); } catch (e) {} }
      });
    }
  };
  try {
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  } catch (e) {
    console.warn('[native-bridge] could not replace speechSynthesis', e);
  }

  // ------------------------------------------------------------------
  // 3 + 4. Purchasing stays on the website; open on the login screen
  // ------------------------------------------------------------------
  var style = document.createElement('style');
  style.textContent =
    'html.pp-native-app #billing button[onclick*="fakeStripe"],' +
    'html.pp-native-app [onclick*="openBillingPortal"],' +
    'html.pp-native-app [onclick*="confirmCancelPlan"]{display:none!important}' +
    'html.pp-native-app .pp-native-billing-note{display:block;margin:0 0 18px;padding:16px 18px;' +
    'border-radius:12px;background:rgba(26,111,255,.10);border:1px solid rgba(26,111,255,.35);' +
    'color:inherit;font-size:14px;line-height:1.5}';
  (document.head || document.documentElement).appendChild(style);

  var WEB_ONLY_MSG = 'Plans and billing are managed on the PayPilot AI website. Sign up or change your plan there, then log in here.';

  document.addEventListener('DOMContentLoaded', function () {
    // Function declarations in index.html are globals; replace them here so any
    // remaining path into checkout explains instead of opening Stripe in-app.
    window.fakeStripe = function (plan, amount) {
      if (plan === 'Enterprise' || amount === 0) {
        window.location.href = 'mailto:info@paypilotai.live?subject=PayPilot Enterprise Inquiry';
        return;
      }
      if (typeof window.toast === 'function') window.toast(WEB_ONLY_MSG);
    };
    window.openBillingPortal = function () {
      if (typeof window.toast === 'function') window.toast(WEB_ONLY_MSG);
    };

    var billing = document.getElementById('billing');
    if (billing && !billing.querySelector('.pp-native-billing-note')) {
      var note = document.createElement('div');
      note.className = 'pp-native-billing-note';
      note.textContent = WEB_ONLY_MSG;
      billing.insertBefore(note, billing.firstChild);
    }

    // First launch (no saved session, no magic-link params): go to login, not
    // the marketing homepage.
    var hasSession = false;
    try { hasSession = !!localStorage.getItem('pp_session'); } catch (e) {}
    if (!hasSession && !location.search && typeof window.showAuth === 'function') {
      window.showAuth();
    }
  });
})();
