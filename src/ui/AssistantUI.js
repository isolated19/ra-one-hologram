import { ConversationPanel } from './ConversationPanel.js';

const STATUS_TEXT = {
  initializing: 'INITIALIZING...',
  idle: 'SYSTEM IDLE',
  sleeping: 'RA-ONE SLEEPING',
  standby: 'STANDBY',
  wake_detected: 'WAKE DETECTED',
  listening: 'LISTENING...',
  thinking: 'THINKING...',
  speaking: 'SPEAKING...',
  dissolved: 'DISPERSED',
  error: 'VOICE ERROR',
  ERROR: 'VOICE ERROR',
};

const MIC_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5M9 20.5h6"/></svg>`;

/**
 * The assistant console: identity, animated status, and the interaction panel
 * (simulated voice button, text input, latest reply, collapsible history).
 * Handlers: onSend(text), onMic(), onCancel().
 */
export class AssistantUI {
  constructor(handlers) {
    this.handlers = handlers;

    this.top = document.createElement('header');
    this.top.className = 'ra-top';
    this.top.innerHTML = `
      <div class="ra-identity">
        <h1 class="ra-title">RA-ONE</h1>
        <p class="ra-sub">COSMIC INTELLIGENCE SYSTEM</p>
      </div>
      <div class="ra-status" data-state="initializing" role="status" aria-live="polite">
        <span class="ra-status-dot" aria-hidden="true"></span>
        <span class="ra-status-text">${STATUS_TEXT.initializing}</span>
      </div>`;

    this.console = document.createElement('section');
    this.console.className = 'ra-console';
    this.console.setAttribute('aria-label', 'Assistant console');
    this.console.innerHTML = `
      <div class="ra-history" hidden></div>
      <div class="ra-voice-slot" id="ra-voice-slot" hidden></div>
      <div class="ra-reply" aria-live="polite">
        <p class="ra-reply-text">Awaiting initialization.</p>
      </div>
      <form class="ra-input-row" autocomplete="off">
        <button type="button" class="ra-mic" aria-label="Toggle hands-free voice" title="Enable hands-free once, then say Hey RA-ONE or clap">${MIC_ICON}</button>
        <input class="ra-input" type="text" maxlength="240" placeholder="Message RA-ONE" aria-label="Message to RA-ONE" />
        <button type="submit" class="ra-send">Send</button>
      </form>
      <div class="ra-meta">
        <span class="ra-core"><i aria-hidden="true"></i>LANGUAGE CORE: LOCAL + WEB${import.meta.env.DEV ? ' · MODULE 2 VOICE' : ''}</span>
        <span class="ra-meta-actions">
          <button type="button" class="ra-camera-toggle" aria-pressed="false" title="Camera face tracking (processed on this PC only)"><i aria-hidden="true"></i><span>Cam off</span></button>
          <button type="button" class="ra-voice-toggle" aria-expanded="false" aria-controls="ra-voice-slot">Voice</button>
          <button type="button" class="ra-history-toggle" aria-expanded="false">History (0)</button>
        </span>
      </div>`;

    document.body.append(this.top, this.console);
    this.voiceSlot = this.console.querySelector('.ra-voice-slot');

    const q = (s) => this.console.querySelector(s);
    this.statusEl = this.top.querySelector('.ra-status');
    this.statusText = this.top.querySelector('.ra-status-text');
    this.replyText = q('.ra-reply-text');
    this.replyBox = q('.ra-reply');
    this.input = q('.ra-input');
    this.mic = q('.ra-mic');
    this.history = new ConversationPanel(q('.ra-history'), q('.ra-history-toggle'));

    // Voice settings stay folded away; like history, they overlay the figure instead of re-framing it
    const voiceToggle = q('.ra-voice-toggle');
    voiceToggle.addEventListener('click', () => {
      const open = this.voiceSlot.hidden;
      this.voiceSlot.hidden = !open;
      voiceToggle.setAttribute('aria-expanded', String(open));
      voiceToggle.classList.toggle('is-open', open);
    });

    q('.ra-input-row').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = '';
      handlers.onSend?.(text);
    });
    this.mic.addEventListener('click', () => handlers.onMic?.());
    this.camera = q('.ra-camera-toggle');
    this.camera.addEventListener('click', () => handlers.onCamera?.());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') handlers.onCancel?.();
    });
  }

  /** Swap the status label with a short fade/slide. */
  setStatus(key) {
    if (this.statusEl.dataset.state === key) return;
    this.statusEl.dataset.state = key;
    this.statusText.classList.add('is-out');
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      this.statusText.textContent = STATUS_TEXT[key] ?? key.toUpperCase();
      this.statusText.classList.remove('is-out');
    }, 180);
  }

  setMicActive(on) {
    this.mic.classList.toggle('is-active', on);
    this.mic.setAttribute('aria-pressed', String(on));
  }

  /** Camera chip: off / on (with the face's current mood) / error. */
  setCamera({ active = false, present = false, emotion = null, error = null } = {}) {
    this.camera.classList.toggle('is-active', active);
    this.camera.classList.toggle('is-error', !!error);
    this.camera.setAttribute('aria-pressed', String(active));
    let label = 'Cam off';
    if (error) label = 'Cam error';
    else if (active) label = present ? `Cam · ${emotion || 'neutral'}` : 'Cam · no face';
    this.camera.querySelector('span').textContent = label;
    this.camera.title = error || 'Camera face tracking (processed on this PC only)';
  }

  setReply(text, { simulated = false, pending = false } = {}) {
    this.replyText.textContent = text;
    this.replyBox.classList.toggle('is-pending', pending);
    this.replyBox.classList.toggle('is-simulated', simulated);
  }

  /** Mount Module 2 hands-free controls into the console. */
  mountVoicePanel(el) {
    if (!this.voiceSlot || !el) return;
    this.voiceSlot.replaceChildren(el);
  }

  /**
   * CSS px the UI covers at the top and bottom, for camera framing.
   * The history and voice panels are excluded so opening them doesn't re-frame the figure.
   */
  insets() {
    const top = this.top.getBoundingClientRect().bottom;
    const bottom = innerHeight - this.replyBox.getBoundingClientRect().top;
    return { top: Math.max(0, top), bottom: Math.max(0, bottom) };
  }
}
