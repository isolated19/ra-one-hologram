import workletUrl from './level-worklet.js?url';

/** A clap is a transient: loud for a few ms, then gone. Speech stays loud for 100 ms+. */
const CONFIRM_MS = 150;   // how long after the onset we watch the decay
const MAX_HOT_MS = 40;    // time allowed above half the onset's max energy
const DECAY_RATIO = 0.3;  // energy at the end of the window must fall below this × max

/**
 * Heuristic clap detector fed by a 10 ms level-meter AudioWorklet.
 * Short-term energy + rise-time + peak vs noise floor + fast decay — not amplitude alone.
 * The worklet runs on the audio thread, so detection keeps working while the window is hidden.
 * Emits debug accept/reject reasons. Default cooldown ~1.5s.
 */
export class ClapDetector {
  /**
   * @param {{
   *   audioSession: import('./AudioSessionManager.js').AudioSessionManager,
   *   sensitivity?: number,
   *   cooldownMs?: number,
   *   enabled?: boolean,
   * }} opts
   */
  constructor({ audioSession, sensitivity = 0.55, cooldownMs = 1500, enabled = true } = {}) {
    this.audioSession = audioSession;
    this.sensitivity = sensitivity;
    this.cooldownMs = cooldownMs;
    this.enabled = enabled;
    this.armed = true;
    this.running = false;
    this._node = null;
    this._sink = null;
    this._ctxWithModule = null;
    this._gen = 0;
    this._noise = 0.02;
    this._lastTrigger = -Infinity;
    this._prevEnergy = 0;
    this._pending = null;
    this._listeners = new Map();
    this.lastDebug = { confidence: 0, reason: 'idle' };
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => fn(payload));
  }

  setSensitivity(v) {
    this.sensitivity = Math.max(0.05, Math.min(1, Number(v) || 0.55));
  }

  setArmed(armed) {
    this.armed = !!armed;
    if (!this.armed) this._pending = null;
  }

  /** Tap the shared mic graph. Call again after the AudioSessionManager re-creates its context. */
  start() {
    if (!this.audioSession.isActive) throw new Error('Audio session inactive');
    this.stop();
    const gen = ++this._gen;
    this.running = true;
    this._prevEnergy = 0;
    return this._attach(gen).catch((err) => {
      if (gen !== this._gen) return;
      this.running = false;
      console.warn('[ClapDetector] level worklet failed', err);
      this._reject('worklet_error');
    });
  }

  async _attach(gen) {
    const ctx = this.audioSession.audioContext;
    if (!ctx || !this.audioSession.sourceNode) throw new Error('Audio session not active');
    if (this._ctxWithModule !== ctx) {
      await ctx.audioWorklet.addModule(workletUrl);
      this._ctxWithModule = ctx;
    }
    if (gen !== this._gen) return;
    const node = new AudioWorkletNode(ctx, 'raone-level');
    node.port.onmessage = (ev) => this._onFrame(ev.data);
    // A muted sink keeps the node pulled by the graph on every browser
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.audioSession.sourceNode.connect(node);
    node.connect(sink).connect(ctx.destination);
    this._node = node;
    this._sink = sink;
  }

  stop() {
    this._gen += 1;
    this.running = false;
    this._pending = null;
    if (this._node) this._node.port.onmessage = null;
    try { this._node?.disconnect(); } catch { /* ignore */ }
    try { this._sink?.disconnect(); } catch { /* ignore */ }
    this._node = null;
    this._sink = null;
  }

  _reject(reason, confidence = 0) {
    this.lastDebug = { confidence, reason, accepted: false };
    this.emit('debug', this.lastDebug);
  }

  /** One 10 ms frame from the worklet: { energy, peak, zcr, t (ms, audio clock) }. */
  _onFrame({ energy, peak, zcr, t }) {
    if (!this.enabled || !this.armed) return;

    if (this._pending) {
      this._trackPending(energy, t);
      return;
    }

    this._noise += (energy - this._noise) * (energy > this._noise ? 0.011 : 0.0036);
    const rise = energy - this._prevEnergy;
    this._prevEnergy = energy * 0.55 + this._prevEnergy * 0.45;

    const peakGate = this._noise * (5.0 - this.sensitivity * 2.4) + (0.2 - this.sensitivity * 0.1);
    const riseGate = 0.05 + (1 - this.sensitivity) * 0.07;
    const conf = Math.min(1, (peak / (peakGate + 1e-6)) * 0.45 + (rise / (riseGate + 1e-6)) * 0.55);

    if (t - this._lastTrigger <= this.cooldownMs) {
      if (peak > peakGate && rise > riseGate) this._reject('cooldown', conf);
      return;
    }
    if (peak <= peakGate) {
      if (peak > peakGate * 0.7) this._reject('peak_low', conf);
      return;
    }
    if (rise <= riseGate) {
      this._reject('rise_low', conf);
      return;
    }
    if (peak <= this._noise * 3.5) {
      this._reject('noise_floor', conf);
      return;
    }
    // Claps are broadband noise (~0.2–0.5 crossings/sample at 16 kHz); voiced syllables and
    // knocks sit well below 0.1. Very high sensitivity keeps only the old knock filter.
    if (zcr < (this.sensitivity >= 0.85 ? 0.04 : 0.1)) {
      this._reject('zcr_voice_like', conf);
      return;
    }

    // Onset looks like a clap — accept only if it dies away like one
    this._pending = { t0: t, lastT: t, maxEnergy: energy, hotMs: 0, conf, peak, rise, zcr };
  }

  _trackPending(energy, t) {
    const p = this._pending;
    const dt = t - p.lastT;
    p.lastT = t;
    if (energy > p.maxEnergy) p.maxEnergy = energy;
    if (energy > p.maxEnergy * 0.5) p.hotMs += dt;
    if (p.hotMs > MAX_HOT_MS) {
      this._pending = null;
      this._prevEnergy = energy;
      this._reject('sustained', p.conf);
      return;
    }
    if (t - p.t0 < CONFIRM_MS) return;

    this._pending = null;
    this._prevEnergy = energy;
    if (energy > p.maxEnergy * DECAY_RATIO) {
      this._reject('slow_decay', p.conf);
      return;
    }
    this._lastTrigger = p.t0;
    this.lastDebug = {
      confidence: p.conf,
      reason: 'accepted',
      accepted: true,
      peak: p.peak,
      rise: p.rise,
      noise: this._noise,
      zcr: p.zcr,
    };
    this.emit('debug', this.lastDebug);
    this.emit('clap', { peak: p.peak, rise: p.rise, noise: this._noise, zcr: p.zcr, confidence: p.conf, at: p.t0 });
  }
}
