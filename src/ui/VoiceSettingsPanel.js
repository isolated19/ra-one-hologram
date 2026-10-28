/**
 * Hands-free / wake / clap / TTS controls. Mounts into the existing console
 * without redesigning the hologram chrome.
 */
export function createVoiceSettingsPanel(handlers = {}) {
  const root = document.createElement('div');
  root.className = 'ra-voice';
  root.setAttribute('aria-label', 'Hands-free voice controls');
  root.innerHTML = `
    <div class="ra-voice-row">
      <button type="button" class="ra-voice-hf is-on" data-action="handsfree" aria-pressed="true">
        Hands-Free: On
      </button>
      <button type="button" class="ra-voice-disable" data-action="disable-hf">
        Disable Hands-Free
      </button>
      <span class="ra-voice-mic" data-mic="unknown" title="Microphone permission">Mic: —</span>
      <span class="ra-voice-wake" data-wake="off" title="Wake detector">Wake: Off</span>
      <span class="ra-voice-clap-dbg" data-clap-dbg="idle" title="Clap detector debug">Clap: —</span>
    </div>
    <div class="ra-voice-transcript" aria-live="polite">
      <span class="ra-voice-label">You</span>
      <p class="ra-voice-you">—</p>
    </div>
    <div class="ra-voice-toggles">
      <label class="ra-voice-check"><input type="checkbox" data-tts checked /> TTS</label>
      <label class="ra-voice-slider">Rate
        <input type="range" data-rate min="0.7" max="1.4" step="0.05" value="1" />
        <output data-rate-out>1.00</output>
      </label>
      <label class="ra-voice-slider">Clap
        <input type="range" data-clap-sens min="0.15" max="0.95" step="0.05" value="0.55" />
        <output data-clap-out>0.55</output>
      </label>
    </div>
    <p class="ra-voice-hint">Mic On ≠ always listening. Wake with clap or “Hey RA-ONE”, then speak. If Wake shows ERROR:NETWORK, Chrome’s speech-to-text lost Google connectivity — clap still works, but type your question (or fix VPN/firewall and refresh). Use Chrome/Edge.</p>
  `;

  const hf = root.querySelector('[data-action="handsfree"]');
  const disableHf = root.querySelector('[data-action="disable-hf"]');
  const mic = root.querySelector('[data-mic]');
  const wake = root.querySelector('[data-wake]');
  const clapDbg = root.querySelector('[data-clap-dbg]');
  const you = root.querySelector('.ra-voice-you');
  const tts = root.querySelector('[data-tts]');
  const rate = root.querySelector('[data-rate]');
  const rateOut = root.querySelector('[data-rate-out]');
  const clapRange = root.querySelector('[data-clap-sens]');
  const clapOut = root.querySelector('[data-clap-out]');

  hf.addEventListener('click', () => handlers.onToggleHandsFree?.());
  disableHf.addEventListener('click', () => handlers.onDisableHandsFree?.());
  tts.addEventListener('change', () => handlers.onTtsEnabled?.(tts.checked));
  rate.addEventListener('input', () => {
    rateOut.textContent = Number(rate.value).toFixed(2);
    handlers.onSpeechRate?.(Number(rate.value));
  });
  clapRange.addEventListener('input', () => {
    clapOut.textContent = Number(clapRange.value).toFixed(2);
    handlers.onClapSensitivity?.(Number(clapRange.value));
  });

  return {
    el: root,
    update(state = {}) {
      if (typeof state.handsFree === 'boolean') {
        hf.textContent = state.handsFree ? 'Hands-Free: On' : 'Hands-Free: Off';
        hf.setAttribute('aria-pressed', String(state.handsFree));
        hf.classList.toggle('is-on', state.handsFree);
        disableHf.hidden = !state.handsFree;
      }
      if (state.micPermission) {
        mic.dataset.mic = state.micPermission;
        const labels = {
          unknown: 'Mic: —',
          granted: 'Mic: On',
          denied: 'Mic: Denied',
          unavailable: 'Mic: N/A',
        };
        mic.textContent = labels[state.micPermission] || `Mic: ${state.micPermission}`;
      }
      if (state.wakeStatus != null) {
        wake.dataset.wake = state.wakeStatus;
        wake.textContent = `Wake: ${String(state.wakeStatus)}`;
      }
      if (state.clapDebug) {
        const d = state.clapDebug;
        clapDbg.dataset.clapDbg = d.accepted ? 'hit' : (d.reason || 'idle');
        clapDbg.textContent = d.accepted
          ? `Clap: OK ${(d.confidence * 100) | 0}%`
          : `Clap: ${d.reason || '—'} ${(d.confidence * 100) | 0}%`;
      }
      if (state.transcript != null) {
        you.textContent = state.transcript || '—';
      }
      if (typeof state.ttsEnabled === 'boolean') tts.checked = state.ttsEnabled;
      if (state.speechRate != null) {
        rate.value = state.speechRate;
        rateOut.textContent = Number(state.speechRate).toFixed(2);
      }
      if (state.clapSensitivity != null) {
        clapRange.value = state.clapSensitivity;
        clapOut.textContent = Number(state.clapSensitivity).toFixed(2);
      }
    },
  };
}
