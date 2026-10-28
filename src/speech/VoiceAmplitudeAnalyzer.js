/**
 * Smoothed voice amplitude from a Web Audio source.
 *
 *   const a = new VoiceAmplitudeAnalyzer();
 *   a.connectMediaElement(audioEl);     // <audio>/<video>; audible by default
 *   a.connectNode(someAudioNode);       // any AudioNode in the shared context
 *   await a.connectStream(mediaStream); // e.g. WebRTC / TTS stream; silent by default
 *   await a.enableMicrophone();         // asks permission only when called
 *   const level = a.sample(dt);         // 0..1, call once per frame
 *   a.disconnect();
 *
 * Level = RMS of time-domain samples, noise-gated, scaled, then attack/release
 * smoothed so the mouth doesn't jitter. With no source it decays to 0.
 */

let sharedContext = null;
export function getAudioContext() {
  if (!sharedContext) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio API is not available in this browser');
    sharedContext = new Ctx();
  }
  return sharedContext;
}

// createMediaElementSource() may be called only once per element: cache it
const elementSources = new WeakMap();

export class VoiceAmplitudeAnalyzer {
  constructor({ attack = 0.03, release = 0.18, gain = 5, noiseFloor = 0.01, fftSize = 1024 } = {}) {
    this.attack = attack;
    this.release = release;
    this.gain = gain;
    this.noiseFloor = noiseFloor;
    this.fftSize = fftSize;
    this.analyser = null;
    this.buffer = null;
    this.source = null;
    this.audible = false;
    this.micStream = null;
    this.level = 0;
  }

  _ensureAnalyser() {
    if (this.analyser) return this.analyser;
    const ctx = getAudioContext();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = 0;
    this.buffer = new Float32Array(this.analyser.fftSize);
    return this.analyser;
  }

  _attach(source, audible) {
    this.disconnect();
    const analyser = this._ensureAnalyser();
    source.connect(analyser);
    if (audible) source.connect(getAudioContext().destination);
    this.source = source;
    this.audible = audible;
    getAudioContext().resume?.();
  }

  connectMediaElement(el, { audible = true } = {}) {
    const ctx = getAudioContext();
    let src = elementSources.get(el);
    if (!src) {
      src = ctx.createMediaElementSource(el);
      elementSources.set(el, src);
    }
    this._attach(src, audible);
  }

  connectNode(node, { audible = false } = {}) {
    this._attach(node, audible);
  }

  async connectStream(stream, { audible = false } = {}) {
    const ctx = getAudioContext();
    await ctx.resume?.();
    this._attach(ctx.createMediaStreamSource(stream), audible);
  }

  /** Requests microphone permission (call from a user gesture). Never audible, to avoid feedback. */
  async enableMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access is not available');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    await this.connectStream(stream, { audible: false });
    this.micStream = stream;
  }

  get connected() {
    return !!this.source;
  }

  disconnect() {
    if (this.source) {
      try { this.source.disconnect(this.analyser); } catch { /* already disconnected */ }
      if (this.audible) {
        try { this.source.disconnect(getAudioContext().destination); } catch { /* already disconnected */ }
      }
    }
    this.source = null;
    this.audible = false;
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
  }

  /** Advance smoothing by dt seconds and return the level (0..1). */
  sample(dt) {
    let target = 0;
    if (this.source && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.buffer);
      let sum = 0;
      for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
      const rms = Math.sqrt(sum / this.buffer.length);
      target = Math.min(1, Math.max(0, (rms - this.noiseFloor) * this.gain));
    }
    const tau = target > this.level ? this.attack : this.release;
    this.level += (target - this.level) * (1 - Math.exp(-dt / tau));
    return this.level;
  }
}
