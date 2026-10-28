/**
 * Lightweight helpers for transcript / response surfaces already in AssistantUI.
 */
export function formatTranscriptLine(role, text) {
  const t = String(text || '').trim();
  if (!t) return '';
  return role === 'user' ? t : t;
}

export function statusLabelForPhase(phase, visualState) {
  const map = {
    standby: 'SYSTEM IDLE',
    listening: 'LISTENING...',
    thinking: 'ANALYZING...',
    speaking: 'SPEAKING...',
    error: 'VOICE ERROR',
  };
  if (phase && map[phase]) return map[phase];
  return visualState ? String(visualState).toUpperCase() : '';
}
