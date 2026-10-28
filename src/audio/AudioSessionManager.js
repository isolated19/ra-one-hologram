/**
 * Owns the microphone MediaStream for hands-free mode.
 * Permission is requested only via user gesture (enableHandsFree).
 */
export class AudioSessionManager {
  constructor({ sampleRate = 16000 } = {}) {
    this.sampleRate = sampleRate;
    this.stream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.permission = 'unknown'; // unknown | granted | denied | unavailable
    this.active = false;
    this._listeners = new Map();
    this._visibilityHandler = null;
    this._trackEndedHandler = null;
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => {
      try { fn(payload); } catch (e) { console.error('[AudioSession]', e); }
    });
  }

  get isActive() {
    return this.active && !!this.stream;
  }

  async enable() {
    if (this.isActive) return this.stream;

    if (!navigator.mediaDevices?.getUserMedia) {
      this.permission = 'unavailable';
      this.emit('permission', { permission: this.permission });
      throw new Error('Microphone API unavailable in this browser');
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      this.permission = 'granted';
      this.active = true;
      this._bindTrackEnded();
      this._bindVisibility();
      await this._ensureGraph();
      this.emit('permission', { permission: this.permission });
      this.emit('active', { active: true });
      return this.stream;
    } catch (err) {
      this.permission = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError'
        ? 'denied'
        : 'unavailable';
      this.emit('permission', { permission: this.permission, error: err?.message });
      this.emit('error', { message: err?.message || 'Microphone access failed', error: err });
      throw err;
    }
  }

  async _ensureGraph() {
    if (!this.stream) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!this.audioContext) {
      this.audioContext = new Ctx({ sampleRate: this.sampleRate });
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    if (!this.sourceNode) {
      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    }
  }

  /** Shared AnalyserNode for clap / visualizers (caller owns disconnect). */
  createAnalyser({ fftSize = 1024, smoothing = 0.4 } = {}) {
    if (!this.audioContext || !this.sourceNode) {
      throw new Error('Audio session not active');
    }
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = smoothing;
    this.sourceNode.connect(analyser);
    return analyser;
  }

  _bindTrackEnded() {
    this._trackEndedHandler = () => {
      this.emit('interrupted', { reason: 'track-ended' });
      this.stop({ silent: true });
      this.emit('error', { message: 'Microphone stream interrupted' });
    };
    this.stream?.getTracks().forEach((t) => t.addEventListener('ended', this._trackEndedHandler));
  }

  _bindVisibility() {
    this._visibilityHandler = async () => {
      if (!this.audioContext) return;
      // Audio keeps running while hidden so clap / "Hey RA-ONE" wake from the tray or a
      // background tab; main.js pauses only the Three.js render loop. Resume in case the
      // browser suspended the context on its own.
      if (!document.hidden && this.active && this.audioContext.state === 'suspended') {
        try { await this.audioContext.resume(); } catch { /* ignore */ }
      }
      this.emit('visibility', { hidden: document.hidden });
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  stop({ silent = false } = {}) {
    this.active = false;
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    this.stream?.getTracks().forEach((t) => {
      if (this._trackEndedHandler) t.removeEventListener('ended', this._trackEndedHandler);
      t.stop();
    });
    this.stream = null;
    this._trackEndedHandler = null;
    try { this.sourceNode?.disconnect(); } catch { /* ignore */ }
    this.sourceNode = null;
    if (this.audioContext) {
      const ctx = this.audioContext;
      this.audioContext = null;
      ctx.close().catch(() => {});
    }
    if (!silent) this.emit('active', { active: false });
  }
}
