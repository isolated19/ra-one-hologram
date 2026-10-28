/**
 * Lightweight structured pipeline events (no raw audio / no secrets by default).
 */
export class PipelineEvents {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.correlationId = null;
    this.marks = new Map();
  }

  begin(correlationId = null) {
    this.correlationId = correlationId || `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.marks.clear();
    return this.correlationId;
  }

  emit(name, extra = {}) {
    const now = performance.now();
    if (!this.marks.has(name)) this.marks.set(name, now);
    const payload = {
      event: name,
      t: Date.now(),
      perf_ms: Math.round(now),
      correlation_id: this.correlationId,
      ...extra,
    };
    try {
      this.onEvent(payload);
    } catch { /* ignore */ }
    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[RA-ONE pipeline]', name, payload);
    }
    return payload;
  }

  latency(fromEvent, toEvent = null) {
    const a = this.marks.get(fromEvent);
    const b = toEvent ? this.marks.get(toEvent) : performance.now();
    if (a == null || b == null) return null;
    return Math.round(b - a);
  }
}
