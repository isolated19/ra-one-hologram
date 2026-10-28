/**
 * Question capture STT.
 * - browser: Chrome/Edge SpeechRecognition (needs Google's STT service)
 * - server:  offline backend /ws/stt (VAD + faster-whisper) via a shared ServerSttClient
 * Same events either way: started, partial, final, empty, error.
 */

// Extra client-side slack before giving up on a server that never answers. Generous on purpose:
// on a busy CPU a transcript can take 10+ s, and dropping it loses what the user said.
const SERVER_RESPONSE_SLACK_MS = 25000;

export function getBrowserSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export class SpeechRecognitionService {
  /**
   * @param {{
   *   lang?: string,
   *   silenceTimeoutMs?: number,
   *   serverClient?: import('./ServerSttClient.js').ServerSttClient | null,
   * }} [opts]
   */
  constructor({ lang = 'en-US', silenceTimeoutMs = 2200, serverClient = null } = {}) {
    this.lang = lang;
    this.silenceTimeoutMs = silenceTimeoutMs;
    this.server = serverClient;
    this.provider = serverClient ? 'server' : 'browser';
    this._serverSeq = 0;
    this._serverTimer = null;
    this.listening = false;
    this._rec = null;
    this._silenceTimer = null;
    this._listeners = new Map();
    this._finalParts = [];
    if (this.server) this._wireServer();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => fn(payload));
  }

  isSupported() {
    if (this.server) return true;
    return !!getBrowserSpeechRecognitionCtor();
  }

  /**
   * Begin capturing a user question (not wake monitoring).
   * Silence timeout starts only after the first audio result so a slow
   * speaker after wake is not cut off before they begin.
   */
  startQuestionCapture({ seed = '', timeoutMs = 9000, initialGraceMs = 5000 } = {}) {
    this.cancel();
    if (this.server) return this._startServerCapture({ seed, timeoutMs, initialGraceMs });
    if (!this.isSupported()) {
      this.emit('error', { error: 'unsupported', message: 'Speech recognition unavailable' });
      return false;
    }

    const Ctor = getBrowserSpeechRecognitionCtor();
    const rec = new Ctor();
    this._rec = rec;
    this._finalParts = seed ? [seed] : [];
    this.listening = true;
    let heardSpeech = false;

    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    const finish = (reason) => {
      if (!this.listening) return;
      this.listening = false;
      clearTimeout(this._silenceTimer);
      clearTimeout(this._hardTimer);
      clearTimeout(this._graceTimer);
      const text = this._finalParts.join(' ').replace(/\s+/g, ' ').trim();
      try { rec.stop(); } catch { /* ignore */ }
      this._rec = null;
      if (!text) {
        this.emit('empty', { reason });
        return;
      }
      this.emit('final', { text, reason });
    };

    this._hardTimer = setTimeout(() => finish('timeout'), timeoutMs);

    const bumpSilence = () => {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = setTimeout(() => finish('silence'), this.silenceTimeoutMs);
    };

    // Wait for the user to start speaking before applying the silence cutoff
    this._graceTimer = setTimeout(() => {
      if (this.listening && !heardSpeech) bumpSilence();
    }, Math.max(1000, initialGraceMs));

    rec.onresult = (ev) => {
      heardSpeech = true;
      clearTimeout(this._graceTimer);
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0]?.transcript || '';
        if (r.isFinal) this._finalParts.push(t.trim());
        else interim += t;
      }
      const preview = [...this._finalParts, interim].join(' ').replace(/\s+/g, ' ').trim();
      this.emit('partial', { text: preview, interim });
      bumpSilence();
    };

    rec.onerror = (ev) => {
      const err = ev.error || 'unknown';
      if (err === 'aborted') return;
      if (err === 'no-speech') {
        // Browser idle tick — only count silence after we have heard something
        if (heardSpeech) bumpSilence();
        return;
      }
      this.emit('error', { error: err });
      finish('error');
    };

    rec.onend = () => {
      if (this.listening) finish('ended');
    };

    try {
      rec.start();
      this.emit('started');
      return true;
    } catch (err) {
      this.listening = false;
      clearTimeout(this._graceTimer);
      this.emit('error', { error: err?.message || String(err) });
      return false;
    }
  }

  // ── server provider ─────────────────────────────────────────────
  _startServerCapture({ seed, timeoutMs, initialGraceMs }) {
    if (!this.server.isOpen) {
      this.emit('error', { error: 'server-unreachable', message: 'Offline STT backend is not connected' });
      return false;
    }
    this._finalParts = seed ? [seed] : [];
    this.listening = true;
    this._serverSeq = this.server.setMode('question', {
      grace_ms: Math.max(1000, initialGraceMs),
      max_ms: timeoutMs,
    });
    // Backend counts audio time; this only guards against a stalled socket
    this._serverTimer = setTimeout(() => this._finishServer('empty', { reason: 'no-response' }),
      timeoutMs + SERVER_RESPONSE_SLACK_MS);
    this.emit('started');
    return true;
  }

  _ownsServer(ev) {
    return this.listening && (ev?.seq == null || ev.seq === this._serverSeq);
  }

  _withSeed(text) {
    return [...this._finalParts, text].join(' ').replace(/\s+/g, ' ').trim();
  }

  _finishServer(event, payload) {
    if (!this.listening) return;
    this.listening = false;
    clearTimeout(this._serverTimer);
    this._serverTimer = null;
    this.emit(event, payload);
  }

  _wireServer() {
    const s = this.server;
    s.on('partial', (ev) => {
      if (ev.mode !== 'question' || !this._ownsServer(ev)) return;
      this.emit('partial', { text: this._withSeed(ev.text), interim: ev.text });
    });
    s.on('final', (ev) => {
      if (!this._ownsServer(ev)) return;
      this._finishServer('final', { text: this._withSeed(ev.text), reason: ev.reason });
    });
    s.on('empty', (ev) => {
      if (!this._ownsServer(ev)) return;
      const seeded = this._withSeed('');
      if (seeded) this._finishServer('final', { text: seeded, reason: ev.reason });
      else this._finishServer('empty', { reason: ev.reason });
    });
    s.on('error', (ev) => {
      if (!this._ownsServer(ev)) return;
      this.emit('error', { error: ev.error || 'server-error', message: ev.message });
      this._finishServer('empty', { reason: 'error' });
    });
    s.on('disconnected', () => {
      if (!this.listening) return;
      this.emit('error', { error: 'server-disconnected' });
      this._finishServer('empty', { reason: 'disconnected' });
    });
  }

  cancel() {
    if (this.server) {
      if (this.listening && this.server.seq === this._serverSeq) this.server.setMode('off');
      clearTimeout(this._serverTimer);
      this._serverTimer = null;
    }
    this.listening = false;
    clearTimeout(this._silenceTimer);
    clearTimeout(this._hardTimer);
    clearTimeout(this._graceTimer);
    try { this._rec?.abort(); } catch { /* ignore */ }
    try { this._rec?.stop(); } catch { /* ignore */ }
    this._rec = null;
  }
}
