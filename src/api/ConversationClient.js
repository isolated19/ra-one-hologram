/**
 * Client for POST /api/conversation/turn — real offline LLM responses.
 */
import { BACKEND_URL } from './config.js';

export class ConversationClient {
  constructor({ baseUrl = BACKEND_URL } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * @param {string} text
   * @param {{ useMock?: boolean, confirmAction?: boolean, correlationId?: string|null,
   *   emotion?: { emotion: string, confidence: number } | null }} [opts]
   */
  async turn(text, { useMock = false, confirmAction = false, correlationId = null, emotion = null } = {}) {
    const res = await fetch(`${this.baseUrl}/api/conversation/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        use_mock: !!useMock,
        confirm_action: !!confirmAction,
        correlation_id: correlationId || undefined,
        // Camera-read expression (on-device); lets RA-ONE answer like a friend who can see you
        emotion: emotion?.emotion
          ? { label: emotion.emotion, confidence: Math.round((emotion.confidence || 0) * 100) / 100 }
          : undefined,
      }),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!res.ok) {
      const detail = data?.detail;
      const errObj = typeof detail === 'object' && detail ? detail : data;
      const message =
        (typeof detail === 'string' && detail)
        || errObj?.error
        || `Conversation failed (${res.status})`;
      const error = new Error(message);
      error.status = res.status;
      error.payload = errObj;
      throw error;
    }
    return data;
  }

  async health() {
    const res = await fetch(`${this.baseUrl}/api/conversation/health`);
    if (!res.ok) throw new Error(`Conversation health ${res.status}`);
    return res.json();
  }

  async clear() {
    const res = await fetch(`${this.baseUrl}/api/conversation/clear`, { method: 'POST' });
    if (!res.ok) throw new Error(`Conversation clear ${res.status}`);
    return res.json();
  }
}
