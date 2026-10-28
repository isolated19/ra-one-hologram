/**
 * Single source of truth for RA-ONE's assistant state.
 *
 *   setState('idle' | 'listening' | 'thinking' | 'speaking', meta?)
 *   getState()
 *   on('change', ({ from, to, meta }) => {})   // also on('idle'), on('thinking'), ...
 *
 * Exactly one state is active. Visuals never read the state name directly:
 * they read `weights` (one 0..1 blend per state) and `params` (the blended
 * visual parameters), both eased toward the active state's targets in update(),
 * so every transition is smooth.
 */
export const STATES = ['idle', 'listening', 'thinking', 'speaking'];

// Visual targets per state. eye: base eye intensity; neural: link activity;
// glitch: ambient glitch rate; dust: peripheral dust activity.
const PROFILES = {
  idle: { eye: 0.5, neural: 0.3, glitch: 0.6, dust: 0.0 },
  listening: { eye: 0.72, neural: 0.55, glitch: 0.3, dust: 0.7 },
  thinking: { eye: 0.92, neural: 1.0, glitch: 1.0, dust: 0.35 },
  speaking: { eye: 0.8, neural: 0.6, glitch: 0.4, dust: 0.3 },
};

export class AssistantStateManager {
  /** @param {{ transitionTime?: number }} [opts] seconds to ~95% of a transition */
  constructor({ transitionTime = 0.75 } = {}) {
    this.state = 'idle';
    this.rate = 3 / transitionTime;
    this.weights = Object.fromEntries(STATES.map((s) => [s, s === 'idle' ? 1 : 0]));
    this.params = { ...PROFILES.idle };
    this.listeners = new Map();
  }

  /** @returns {boolean} true if the state changed */
  setState(name, meta = {}) {
    if (!STATES.includes(name)) throw new Error(`Unknown assistant state "${name}"`);
    if (name === this.state) return false;
    const from = this.state;
    this.state = name;
    this.emit('change', { from, to: name, meta });
    this.emit(name, { from, to: name, meta });
    return true;
  }

  getState() {
    return this.state;
  }

  /** Subscribe; returns an unsubscribe function. */
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this.listeners.get(event)?.delete(fn);
  }

  emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => fn(payload));
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * this.rate);
    for (const s of STATES) {
      this.weights[s] += ((s === this.state ? 1 : 0) - this.weights[s]) * k;
    }
    const target = PROFILES[this.state];
    for (const key in target) this.params[key] += (target[key] - this.params[key]) * k;
  }
}
