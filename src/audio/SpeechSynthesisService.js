/**
 * Provider-independent TTS facade.
 * Browser SpeechSynthesis for Module 2; Piper/cloud can plug in later.
 * Does not expose raw samples — use simulated mouth envelope while speaking.
 */

export class SpeechSynthesisService {
  constructor({
    rate = 1,
    pitch = 1,
    volume = 1,
    lang = 'en-US',
    enabled = true,
  } = {}) {
    this.rate = rate;
    this.pitch = pitch;
    this.volume = volume;
    this.lang = lang;
    this.enabled = enabled;
    this.speaking = false;
    this._utterance = null;
    this._listeners = new Map();
    this._voiceURI = null;
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
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  listVoices() {
    if (!this.isSupported()) return [];
    return speechSynthesis.getVoices();
  }

  setVoiceURI(uri) {
    this._voiceURI = uri;
  }

  setRate(v) {
    this.rate = Math.max(0.5, Math.min(2, Number(v) || 1));
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.cancel();
  }

  /** Speak text; cancels any in-flight utterance (no overlap). */
  speak(text) {
    const content = String(text || '').trim();
    if (!content) {
      this.emit('error', { message: 'Empty TTS text' });
      return Promise.reject(new Error('Empty TTS text'));
    }
    if (!this.enabled) {
      // Still resolve so UI flow can complete without audio
      this.emit('start', { text: content, silent: true });
      this.emit('end', { text: content, silent: true });
      return Promise.resolve({ silent: true });
    }
    if (!this.isSupported()) {
      this.emit('error', { message: 'SpeechSynthesis unavailable' });
      return Promise.reject(new Error('SpeechSynthesis unavailable'));
    }

    this.cancel();
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(content);
      u.lang = this.lang;
      u.rate = this.rate;
      u.pitch = this.pitch;
      u.volume = this.volume;
      const voices = this.listVoices();
      const preferred = this._voiceURI
        ? voices.find((v) => v.voiceURI === this._voiceURI)
        : voices.find((v) => v.lang?.startsWith('en') && /female|zira|samantha|google us/i.test(v.name))
          || voices.find((v) => v.lang?.startsWith('en'));
      if (preferred) u.voice = preferred;

      this._utterance = u;
      this.speaking = true;

      u.onstart = () => this.emit('start', { text: content });
      u.onend = () => {
        this.speaking = false;
        this._utterance = null;
        this.emit('end', { text: content });
        resolve({ silent: false });
      };
      u.onerror = (ev) => {
        this.speaking = false;
        this._utterance = null;
        const err = ev.error || 'tts-error';
        this.emit('error', { error: err });
        if (err === 'canceled' || err === 'interrupted') resolve({ canceled: true });
        else reject(new Error(err));
      };

      // Chrome sometimes needs getVoices() warm-up
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  }

  cancel() {
    if (!this.isSupported()) return;
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    if (this.speaking) {
      this.speaking = false;
      this.emit('cancel');
    }
    this._utterance = null;
  }
}

/**
 * Simulated amplitude envelope for mouth animation during browser TTS
 * (SpeechSynthesisUtterance does not expose samples).
 */
export class SimulatedSpeechEnvelope {
  constructor() {
    this.active = false;
    this.t0 = 0;
    this.level = 0;
  }

  start() {
    this.active = true;
    this.t0 = performance.now();
    this.level = 0;
  }

  stop() {
    this.active = false;
    this.level = 0;
  }

  /** @returns {number} 0..1 */
  update() {
    if (!this.active) {
      this.level *= 0.85;
      return this.level;
    }
    const t = (performance.now() - this.t0) / 1000;
    // Syllable-like pulses with slight randomness
    const pulse = 0.35 + 0.45 * Math.abs(Math.sin(t * 9.2)) * (0.55 + 0.45 * Math.abs(Math.sin(t * 3.1)));
    const attack = Math.min(1, t * 4);
    this.level = pulse * attack;
    return this.level;
  }
}
