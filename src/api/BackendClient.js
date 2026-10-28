/**
 * RA-ONE Module 1 — FastAPI / WebSocket client.
 *
 * - Configurable backend URL (see config.js)
 * - WebSocket with capped exponential backoff reconnect
 * - Event subscriptions: 'connection', 'assistant.state', 'error'
 * - Does NOT own hologram rendering or AssistantStateManager
 */
import { ASSISTANT_STATES, BACKEND_URL, WS_ASSISTANT_URL } from './config.js';

const MAX_BACKOFF_MS = 15000;
const BASE_BACKOFF_MS = 500;

export class BackendClient {
  /**
   * @param {{ baseUrl?: string, wsUrl?: string, autoConnect?: boolean }} [opts]
   */
  constructor({
    baseUrl = BACKEND_URL,
    wsUrl = WS_ASSISTANT_URL,
    autoConnect = true,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.wsUrl = wsUrl;
    this.status = 'disconnected'; // disconnected | connecting | connected | error
    this._ws = null;
    this._listeners = new Map();
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._closedByUser = false;
    this._lastState = null;
    this.devMode = null;

    if (autoConnect) this.connect();
  }

  /** Subscribe; returns unsubscribe. Events: connection | assistant.state | error */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error('[RA-ONE BackendClient] listener error', err);
      }
    });
  }

  _setStatus(status, detail = {}) {
    this.status = status;
    this.emit('connection', { status, ...detail });
  }

  async fetchHealth() {
    const res = await fetch(`${this.baseUrl}/api/health`);
    if (!res.ok) throw new Error(`Health check failed (${res.status})`);
    const data = await res.json();
    this.devMode = Boolean(data.dev_mode);
    return data;
  }

  async fetchStatus() {
    const res = await fetch(`${this.baseUrl}/api/assistant/status`);
    if (!res.ok) throw new Error(`Status failed (${res.status})`);
    return res.json();
  }

  /**
   * Development-only: POST a new assistant state.
   * Rejects when the backend forbids mutation (production / DEV_MODE=false).
   */
  async setRemoteState(state, source = 'frontend') {
    if (!ASSISTANT_STATES.includes(state)) {
      throw new Error(`Invalid assistant state "${state}"`);
    }
    const res = await fetch(`${this.baseUrl}/api/assistant/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, source }),
    });
    if (res.status === 403) {
      throw new Error('Backend rejected state mutation (dev endpoint disabled)');
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = body.detail ?? detail;
      } catch { /* ignore */ }
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return res.json();
  }

  connect() {
    this._closedByUser = false;
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this._clearReconnect();
    this._setStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this._setStatus('error', { error: err });
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.onopen = () => {
      this._reconnectAttempt = 0;
      this._setStatus('connected');
      // Probe health for dev_mode flag (non-blocking)
      this.fetchHealth().catch(() => {});
    };

    ws.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        this.emit('error', { message: 'Invalid JSON from backend', raw: ev.data });
        return;
      }
      if (data?.type === 'assistant.state' && ASSISTANT_STATES.includes(data.state)) {
        this._lastState = data.state;
        this.emit('assistant.state', data);
      }
    };

    ws.onerror = () => {
      // onclose handles reconnect; surface status for UI
      this._setStatus('error');
    };

    ws.onclose = () => {
      this._ws = null;
      if (this._closedByUser) {
        this._setStatus('disconnected');
        return;
      }
      this._setStatus('disconnected');
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    this._clearReconnect();
    const attempt = this._reconnectAttempt++;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    this._reconnectTimer = setTimeout(() => {
      if (!this._closedByUser) this.connect();
    }, delay);
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  disconnect() {
    this._closedByUser = true;
    this._clearReconnect();
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._setStatus('disconnected');
  }

  get lastState() {
    return this._lastState;
  }

  get isConnected() {
    return this.status === 'connected';
  }
}

export function createBackendClient(opts) {
  return new BackendClient(opts);
}
