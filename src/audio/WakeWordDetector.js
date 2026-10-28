/**
 * Wake-phrase detector.
 * - browser: Chrome/Edge SpeechRecognition + nameNormalizer matching (needs Google's STT service)
 * - server:  offline backend /ws/stt (Vosk wake gate + whisper) via a shared ServerSttClient
 * Same events either way: started, partial, wake, error, unsupported. Does not persist audio.
 */
import { matchWakePhrase, normalizeForMatch } from '../assistant/nameNormalizer.js';

export { matchWakePhrase, normalizeForMatch as normalizeTranscript };

export class WakeWordDetector {
  /**
   * @param {{
   *   recognitionFactory?: () => SpeechRecognition | null,
   *   serverClient?: import('./ServerSttClient.js').ServerSttClient | null,
   *   lang?: string,
   *   enabled?: boolean,
   * }} [opts]
   */
  constructor({
    recognitionFactory = defaultRecognitionFactory,
    serverClient = null,
    lang = 'en-US',
    enabled = true,
  } = {}) {
    this.recognitionFactory = recognitionFactory;
    this.server = serverClient;
    this._serverSeq = 0;
    this.lang = lang;
    this.enabled = enabled;
    this.armed = true;
    this.running = false;
    this._rec = null;
    this._restartAttempt = 0;
    this._restartTimer = null;
    this._listeners = new Map();
    this._closed = false;
    this._lastWakeAt = 0;
    this.debounceMs = 900;
    if (this.server) this._wireServer();
  }

  get provider() {
    return this.server ? 'server' : 'browser';
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => fn(payload));
  }

  setArmed(armed) {
    this.armed = !!armed;
  }

  isSupported() {
    if (this.server) return true;
    return !!this.recognitionFactory();
  }

  start() {
    this._closed = false;
    if (!this.enabled) return;
    if (this.running) return;
    if (this.server) {
      this.running = true;
      this._serverSeq = this.server.setMode('wake');
      return; // 'started' fires when the server acknowledges the mode
    }
    const Rec = this.recognitionFactory();
    if (!Rec) {
      this.emit('unsupported', { reason: 'SpeechRecognition unavailable' });
      return;
    }
    this._rec = Rec;
    this._rec.lang = this.lang;
    this._rec.continuous = true;
    this._rec.interimResults = true;
    this._rec.maxAlternatives = 3;

    this._rec.onresult = (ev) => {
      if (!this.armed || !this.enabled) return;
      let best = '';
      let bestScore = -1;
      let final = false;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        final = res.isFinal || final;
        for (let a = 0; a < res.length; a++) {
          const alt = res[a];
          const conf = alt.confidence ?? (a === 0 ? 0.6 : 0.3);
          if (conf >= bestScore) {
            bestScore = conf;
            best = alt.transcript || best;
          }
        }
      }
      this.emit('partial', { text: best, final: !!final, confidence: bestScore });

      const hit = matchWakePhrase(best);
      if (!hit.matched) return;
      // Conservative: prefer final results, or high-confidence interim
      if (!final && bestScore >= 0 && bestScore < 0.45) return;
      const now = performance.now();
      if (now - this._lastWakeAt < this.debounceMs) return;
      this._lastWakeAt = now;
      this.emit('wake', {
        transcript: best,
        remainder: hit.remainder,
        wakeSpan: hit.wakeSpan,
        greeting: hit.greeting,
        canonical: hit.canonical,
        confidence: bestScore,
        final: !!final,
      });
    };

    this._rec.onerror = (ev) => {
      const err = ev.error || 'unknown';
      if (err === 'aborted' || err === 'no-speech') return;
      this.emit('error', { error: err });
      // Chrome Web Speech often dies with "network" — force a clean restart
      if (err === 'network' || err === 'service-not-allowed') {
        this._scheduleRestart({ force: true, reason: err });
      }
    };

    this._rec.onend = () => {
      this.running = false;
      if (this._closed || !this.enabled) return;
      this._scheduleRestart({ force: false });
    };

    try {
      this._rec.start();
      this.running = true;
      this._restartAttempt = 0;
      this.emit('started');
    } catch (err) {
      this.emit('error', { error: err?.message || String(err) });
      this._scheduleRestart({ force: true, reason: 'start-failed' });
    }
  }

  _scheduleRestart({ force = false, reason = 'end' } = {}) {
    if (this._closed || !this.enabled) return;
    if (this._restartTimer) clearTimeout(this._restartTimer);
    // Tear down the dead instance so the next start() creates a fresh one
    try { this._rec?.abort(); } catch { /* ignore */ }
    this._rec = null;
    this.running = false;
    const attempt = this._restartAttempt;
    this._restartAttempt += 1;
    // Network failures: retry sooner (Chrome STT needs Google connectivity)
    const base = (reason === 'network' || force) ? 600 : 400;
    const delay = Math.min(10000, base * 2 ** Math.min(attempt, 4));
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (!this._closed && this.enabled && !this.running) this.start();
    }, delay);
  }

  // ── server provider ─────────────────────────────────────────────
  _ownsServer(ev) {
    return this.running && (ev?.seq == null || ev.seq === this._serverSeq);
  }

  _wireServer() {
    const s = this.server;
    s.on('mode', (ev) => {
      if (!this._ownsServer(ev)) return;
      if (ev.mode === 'wake') this.emit('started');
      else this.running = false; // server goes off by itself after a wake
    });
    s.on('partial', (ev) => {
      if (ev.mode !== 'wake' || !this._ownsServer(ev) || !this.armed) return;
      this.emit('partial', { text: ev.text, final: false, confidence: ev.confidence ?? 1 });
    });
    s.on('wake', (ev) => {
      if (!this._ownsServer(ev)) return;
      this.running = false;
      if (!this.armed || !this.enabled) {
        // Disarmed (e.g. RA-ONE speaking): swallow it and keep listening
        if (!this._closed) this.start();
        return;
      }
      this._lastWakeAt = performance.now();
      this.emit('wake', {
        transcript: ev.transcript || '',
        remainder: ev.remainder || '',
        wakeSpan: '',
        greeting: ev.greeting || null,
        canonical: 'ra_one',
        confidence: ev.confidence ?? 1,
        final: true,
      });
    });
    s.on('error', (ev) => {
      if (this._ownsServer(ev)) this.emit('error', { error: ev.error || 'server-error', message: ev.message });
    });
    s.on('disconnected', () => {
      // The client reconnects and replays the wake mode; surface the gap meanwhile
      if (this.running) this.emit('error', { error: 'server-disconnected' });
    });
  }

  stop() {
    this._closed = true;
    if (this.server) {
      if (this.running && this.server.seq === this._serverSeq) this.server.setMode('off');
      this.running = false;
      return;
    }
    if (this._restartTimer) clearTimeout(this._restartTimer);
    this._restartTimer = null;
    try { this._rec?.stop(); } catch { /* ignore */ }
    try { this._rec?.abort(); } catch { /* ignore */ }
    this._rec = null;
    this.running = false;
  }
}

export function defaultRecognitionFactory() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  return new Ctor();
}
