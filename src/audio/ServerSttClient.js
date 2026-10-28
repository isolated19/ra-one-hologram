/**
 * Streams mic PCM to the backend's offline STT (/ws/stt) and relays its events.
 * One instance is shared by WakeWordDetector and SpeechRecognitionService (provider 'server');
 * only one server mode (off | wake | question) is active at a time.
 *
 * Every mode request carries a seq; events tagged with an older seq are dropped so a late
 * "final" from a cancelled question can never leak into the next turn.
 */
import workletUrl from './pcm-worklet.js?url';
import { WS_STT_URL } from '../api/config.js';

const RECONNECT_MAX_MS = 10000;

export class ServerSttClient {
  /**
   * @param {{ url?: string, WebSocketImpl?: typeof WebSocket }} [opts]
   */
  constructor({ url = WS_STT_URL, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.mode = 'off';
    this.modeOpts = {};
    this.seq = 0;
    this.ready = false;
    this._ws = null;
    this._closed = true;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._listeners = new Map();
    this._node = null;
    this._sink = null;
    this._ctxWithModule = null;
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => {
      try { fn(payload); } catch (e) { console.error('[ServerStt]', e); }
    });
  }

  get isOpen() {
    return !!this._ws && this._ws.readyState === 1 && this.ready;
  }

  // ── socket ──────────────────────────────────────────────────────
  connect() {
    this._closed = false;
    if (this._ws) return;
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (err) {
      this.emit('error', { error: 'connect-failed', message: err?.message || String(err) });
      this._scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onmessage = (ev) => this._onMessage(ev.data);
    ws.onclose = () => {
      const wasReady = this.ready;
      this._ws = null;
      this.ready = false;
      if (wasReady) this.emit('disconnected', {});
      if (!this._closed) this._scheduleReconnect();
    };
    ws.onerror = () => {
      this.emit('error', { error: 'server-unreachable', message: `Offline STT not reachable at ${this.url}` });
    };
  }

  close() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    try { this._ws?.close(); } catch { /* ignore */ }
    this._ws = null;
    this.ready = false;
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    const delay = Math.min(RECONNECT_MAX_MS, 500 * 2 ** Math.min(this._reconnectAttempt, 5));
    this._reconnectAttempt += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._closed) this.connect();
    }, delay);
  }

  _onMessage(raw) {
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    if (ev.type === 'ready') {
      this.ready = true;
      this._reconnectAttempt = 0;
      this.emit('ready', ev);
      // Restore whatever mode the assistant wanted before the (re)connect
      if (this.mode !== 'off') this._sendMode();
      return;
    }
    // Untagged events (e.g. models-missing) always pass; tagged ones must match the live request
    if (ev.seq !== undefined && ev.seq !== null && ev.seq !== this.seq) return;
    if (ev.type === 'mode') this.mode = ev.mode;
    this.emit(ev.type, ev);
  }

  // ── modes ───────────────────────────────────────────────────────
  /**
   * @param {'off'|'wake'|'question'} mode
   * @param {{ grace_ms?: number, silence_ms?: number, max_ms?: number }} [opts]
   * @returns {number} seq of this request
   */
  setMode(mode, opts = {}) {
    this.seq += 1;
    this.mode = mode;
    this.modeOpts = opts;
    this._sendMode();
    return this.seq;
  }

  _sendMode() {
    if (!this._ws || this._ws.readyState !== 1) return;
    this._ws.send(JSON.stringify({ cmd: 'mode', value: this.mode, seq: this.seq, ...this.modeOpts }));
  }

  // ── audio ───────────────────────────────────────────────────────
  /**
   * Tap the shared mic graph. Call again after the AudioSessionManager re-creates its context.
   * @param {import('./AudioSessionManager.js').AudioSessionManager} session
   */
  async attach(session) {
    const ctx = session.audioContext;
    if (!ctx || !session.sourceNode) throw new Error('Audio session not active');
    this.detach();
    if (this._ctxWithModule !== ctx) {
      await ctx.audioWorklet.addModule(workletUrl);
      this._ctxWithModule = ctx;
    }
    const node = new AudioWorkletNode(ctx, 'pcm16-capture');
    node.port.onmessage = (ev) => this._sendAudio(ev.data);
    // A muted sink keeps the node pulled by the graph on every browser
    const sink = ctx.createGain();
    sink.gain.value = 0;
    session.sourceNode.connect(node);
    node.connect(sink).connect(ctx.destination);
    this._node = node;
    this._sink = sink;
  }

  detach() {
    try { this._node?.disconnect(); } catch { /* ignore */ }
    try { this._sink?.disconnect(); } catch { /* ignore */ }
    if (this._node) this._node.port.onmessage = null;
    this._node = null;
    this._sink = null;
  }

  _sendAudio(buf) {
    // Server discards audio while off; skipping it here saves the socket the traffic
    if (this.mode === 'off' || !this._ws || this._ws.readyState !== 1 || !this.ready) return;
    this._ws.send(buf);
  }
}
