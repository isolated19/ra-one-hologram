/**
 * Client for FastAPI offline Piper TTS (/api/voice/synthesize).
 * Plays WAV via Web Audio and drives mouth amplitude from a real AnalyserNode.
 */
import { BACKEND_URL } from '../api/config.js';

export class OfflineVoiceClient {
  /**
   * @param {{ baseUrl?: string, speech?: import('../speech/SpeechVisualizer.js').SpeechVisualizer }} [opts]
   */
  constructor({ baseUrl = BACKEND_URL, speech = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.speech = speech;
    this.audioCtx = null;
    this._source = null;
    this._analyser = null;
    this._raf = 0;
    this._playing = false;
    this._generation = 0;
    this._listeners = new Map();
    this._lastBlobUrl = null;
    this._lastWav = null;
    this.preset = 'raone_jarvis';
    this.voiceId = null;
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => fn(payload));
  }

  get isPlaying() {
    return this._playing;
  }

  async fetchStatus() {
    const res = await fetch(`${this.baseUrl}/api/voice/status`);
    if (!res.ok) throw new Error(`Voice status ${res.status}`);
    return res.json();
  }

  async fetchPresets() {
    const res = await fetch(`${this.baseUrl}/api/voice/presets`);
    if (!res.ok) throw new Error(`Voice presets ${res.status}`);
    return res.json();
  }

  /**
   * @param {string} text
   * @param {{ preset?: string, voice_id?: string, overrides?: object }} [opts]
   * @returns {Promise<{ blob: Blob, meta: object }>}
   */
  async synthesize(text, opts = {}) {
    const body = {
      text,
      preset: opts.preset || this.preset,
      voice_id: opts.voice_id || this.voiceId || undefined,
      ...(opts.overrides || {}),
    };
    const res = await fetch(`${this.baseUrl}/api/voice/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const j = await res.json();
        detail = j.detail || detail;
      } catch { /* ignore */ }
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    const meta = {
      voiceId: res.headers.get('X-RAONE-Voice-Id'),
      preset: res.headers.get('X-RAONE-Preset'),
      latencyMs: Number(res.headers.get('X-RAONE-Latency-Ms') || 0),
      durationSec: Number(res.headers.get('X-RAONE-Duration-Sec') || 0),
      peak: Number(res.headers.get('X-RAONE-Peak') || 0),
      clipped: res.headers.get('X-RAONE-Clipped') === '1',
      piperVersion: res.headers.get('X-RAONE-Piper-Version'),
    };
    const blob = await res.blob();
    this._lastWav = blob;
    this.emit('synthesized', { meta, size: blob.size });
    return { blob, meta };
  }

  async ensureContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!this.audioCtx) this.audioCtx = new Ctx();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    return this.audioCtx;
  }

  stop() {
    this._generation += 1;
    this._playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    try { this._source?.stop(); } catch { /* ignore */ }
    this._source = null;
    this._analyser = null;
    if (this.speech) this.speech.setExternalAmplitude(null);
    if (this._lastBlobUrl) {
      URL.revokeObjectURL(this._lastBlobUrl);
      this._lastBlobUrl = null;
    }
    this.emit('stop');
  }

  /**
   * Play a WAV blob with analyser-driven mouth sync.
   * Interrupts any current playback.
   */
  async playBlob(blob, { onStart, onEnd } = {}) {
    this.stop();
    const gen = this._generation;
    const ctx = await this.ensureContext();
    const arrayBuf = await blob.arrayBuffer();
    if (gen !== this._generation) return;
    const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
    if (gen !== this._generation) return;

    const source = ctx.createBufferSource();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.35;
    source.buffer = audioBuf;
    source.connect(analyser);
    analyser.connect(ctx.destination);

    this._source = source;
    this._analyser = analyser;
    this._playing = true;
    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      if (!this._playing || gen !== this._generation) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.min(1, Math.sqrt(sum / data.length) * 3.4);
      if (this.speech) this.speech.setExternalAmplitude(rms);
      this.emit('amplitude', { level: rms });
      this._raf = requestAnimationFrame(tick);
    };

    await new Promise((resolve, reject) => {
      source.onended = () => {
        if (gen !== this._generation) {
          resolve();
          return;
        }
        this._playing = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
        if (this.speech) this.speech.setExternalAmplitude(null);
        onEnd?.();
        this.emit('ended');
        resolve();
      };
      try {
        source.start(0);
        onStart?.();
        this.emit('start');
        tick();
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Synthesize then play; prevents overlapping by stopping prior speech. */
  async speak(text, opts = {}) {
    const { blob, meta } = await this.synthesize(text, opts);
    await this.playBlob(blob);
    return meta;
  }

  get lastWav() {
    return this._lastWav;
  }

  downloadLast(filename = 'raone-voice.wav') {
    if (!this._lastWav) throw new Error('No synthesized audio yet');
    const url = URL.createObjectURL(this._lastWav);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}
