/**
 * On-device camera tracking: where the user's face is and which expression it shows.
 * Frames never leave this page — face-api (TF.js) runs the tiny face detector and the
 * expression net locally; the models ship in public/models/face.
 *
 * Events:
 *   state   { active, error? }
 *   face    { present, x, y, emotion, confidence }   every tick (x/y: -1..1 screen space, +y up)
 *   emotion { emotion, confidence, previous }         when the dominant expression holds steady
 */
const MODEL_URL = `${import.meta.env.BASE_URL}models/face`;
const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];

let faceapiPromise = null;

/** Lazy so the ~1.3 MB TF.js bundle never delays the hologram's first paint. */
async function loadFaceApi() {
  faceapiPromise ??= (async () => {
    const faceapi = await import('@vladmandic/face-api');
    try {
      await faceapi.tf.setBackend('webgl');
    } catch {
      await faceapi.tf.setBackend('cpu');
    }
    await faceapi.tf.ready();
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
    ]);
    return faceapi;
  })();
  try {
    return await faceapiPromise;
  } catch (err) {
    faceapiPromise = null;
    throw err;
  }
}

export class FaceEmotionTracker {
  /**
   * @param {{ intervalMs?: number, smoothing?: number, holdMs?: number }} [opts]
   *   smoothing: weight of each new frame in the running expression average
   *   holdMs:    how long an expression must stay dominant before 'emotion' fires
   */
  constructor({ intervalMs = 400, smoothing = 0.35, holdMs = 1500 } = {}) {
    this.intervalMs = intervalMs;
    this.smoothing = smoothing;
    this.holdMs = holdMs;
    this.active = false;
    /** While true the camera stays on but detection stops (frees CPU for speech-to-text / LLM). */
    this.paused = false;
    this.error = null;
    this._listeners = new Map();
    this._video = null;
    this._stream = null;
    this._timer = null;
    this._busy = false;
    this._scores = Object.fromEntries(EMOTIONS.map((e) => [e, e === 'neutral' ? 1 : 0]));
    this._candidate = { emotion: 'neutral', since: 0 };
    this._lastSeenAt = 0;
    this.current = { present: false, x: 0, y: 0, emotion: 'neutral', confidence: 0 };
    this.stableEmotion = 'neutral';
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => {
      try { fn(payload); } catch (e) { console.error('[FaceTracker]', e); }
    });
  }

  static isSupported() {
    return !!navigator.mediaDevices?.getUserMedia;
  }

  /** Mood snapshot for the conversation: only the steady expression, not per-frame noise. */
  mood() {
    if (!this.active || !this.current.present) return null;
    return {
      present: true,
      emotion: this.stableEmotion,
      confidence: this._scores[this.stableEmotion] || 0,
    };
  }

  async start() {
    if (this.active) return;
    if (!FaceEmotionTracker.isSupported()) throw new Error('Camera not available in this browser');
    this.error = null;
    try {
      const [faceapi, stream] = await Promise.all([
        loadFaceApi(),
        navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
          audio: false,
        }),
      ]);
      this._faceapi = faceapi;
      this._stream = stream;
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      this._video = video;
      this.active = true;
      this.emit('state', { active: true });
      this._schedule();
    } catch (err) {
      this.stop();
      this.error = err?.name === 'NotAllowedError' ? 'Camera permission denied' : (err?.message || String(err));
      this.emit('state', { active: false, error: this.error });
      throw new Error(this.error);
    }
  }

  stop() {
    clearTimeout(this._timer);
    this._timer = null;
    this._stream?.getTracks().forEach((t) => t.stop());
    this._stream = null;
    if (this._video) this._video.srcObject = null;
    this._video = null;
    const was = this.active;
    this.active = false;
    this.current = { ...this.current, present: false };
    if (was) this.emit('state', { active: false });
  }

  _schedule() {
    clearTimeout(this._timer);
    if (!this.active) return;
    this._timer = setTimeout(() => this._tick(), this.intervalMs);
  }

  setPaused(on) {
    this.paused = !!on;
  }

  async _tick() {
    if (!this.active || this._busy || this.paused || !this._video) return this._schedule();
    this._busy = true;
    try {
      const faceapi = this._faceapi;
      const result = await faceapi
        .detectSingleFace(this._video, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.4 }))
        .withFaceExpressions();
      this._ingest(result, performance.now());
    } catch (err) {
      console.warn('[FaceTracker] detection failed:', err?.message || err);
    } finally {
      this._busy = false;
      this._schedule();
    }
  }

  /**
   * Fold one detection into the smoothed state. Exposed for tests.
   * @param {{ detection: { box: { x: number, y: number, width: number, height: number } },
   *   expressions: Record<string, number> } | undefined} result
   */
  _ingest(result, now, { videoWidth = this._video?.videoWidth || 320, videoHeight = this._video?.videoHeight || 240 } = {}) {
    if (!result) {
      // Brief misses (blink, head turn) shouldn't make the face "leave"
      if (this.current.present && now - this._lastSeenAt > 1500) {
        this.current = { ...this.current, present: false };
      }
      this.emit('face', this.current);
      return;
    }
    this._lastSeenAt = now;
    const k = this.smoothing;
    for (const e of EMOTIONS) {
      this._scores[e] = (1 - k) * this._scores[e] + k * (result.expressions[e] || 0);
    }
    let emotion = 'neutral';
    for (const e of EMOTIONS) if (this._scores[e] > this._scores[emotion]) emotion = e;

    const { x, y, width, height } = result.detection.box;
    // The camera sees a mirror image: the user's right is the image's left
    this.current = {
      present: true,
      x: -(((x + width / 2) / videoWidth) * 2 - 1),
      y: 1 - ((y + height / 2) / videoHeight) * 2,
      emotion,
      confidence: this._scores[emotion],
    };

    if (emotion !== this._candidate.emotion) this._candidate = { emotion, since: now };
    else if (emotion !== this.stableEmotion && now - this._candidate.since >= this.holdMs) {
      const previous = this.stableEmotion;
      this.stableEmotion = emotion;
      this.emit('emotion', { emotion, confidence: this._scores[emotion], previous });
    }
    this.emit('face', this.current);
  }
}

export { EMOTIONS };
