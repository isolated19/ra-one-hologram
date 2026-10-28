/**
 * Developer panel: collapsible (DEV button) and fully hideable
 * (Hide button or Ctrl+Shift+D toggles; ?dev=0 starts hidden).
 * Calls the handlers passed in; returns setters to keep it in sync.
 */
export function createDebugPanel(h) {
  const toggle = document.createElement('button');
  toggle.className = 'ra-dev-toggle';
  toggle.type = 'button';
  toggle.textContent = 'DEV';
  toggle.title = 'Developer panel (Ctrl+Shift+D hides it completely)';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'ra-dev');

  const root = document.createElement('aside');
  root.id = 'ra-dev';
  root.className = 'ra-dev';
  root.hidden = true;
  root.setAttribute('aria-label', 'Developer panel');
  const slider = (id, label, min, max, step, value, fmt) => `
    <label class="ra-dev-row">${label} <output id="v-${id}">${fmt(value)}</output>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" /></label>`;
  const pct = (v) => `${Math.round(v * 100)}%`;
  const fx = (v) => Number(v).toFixed(2);
  root.innerHTML = `
    <header>DEVELOPER <button type="button" class="ra-dev-hide" title="Hide completely (Ctrl+Shift+D to restore)">Hide</button></header>
    <section>
      <h2>Backend <span class="ra-backend-pill" data-conn="disconnected" title="FastAPI connection">OFFLINE</span></h2>
      <p class="ra-dev-note ra-backend-url" id="backend-url"></p>
      <div class="ra-dev-grid" role="group" aria-label="Backend assistant state">
        <button type="button" data-backend-state="idle">Idle</button>
        <button type="button" data-backend-state="listening">Listening</button>
        <button type="button" data-backend-state="thinking">Thinking</button>
        <button type="button" data-backend-state="speaking">Speaking</button>
      </div>
      <p class="ra-dev-note">Backend buttons POST to FastAPI (dev only) and sync the hologram over WebSocket.</p>
    </section>
    <section>
      <h2>State</h2>
      <div class="ra-dev-grid" role="group" aria-label="Assistant state">
        <button data-state="idle">Idle</button>
        <button data-state="listening">Listening</button>
        <button data-state="thinking">Thinking</button>
        <button data-state="speaking">Speaking</button>
      </div>
      <button class="ra-dev-wide" data-action="demo">Play full interaction demo</button>
    </section>
    <section>
      <h2>Animation</h2>
      <div class="ra-dev-grid">
        <button data-action="pulse">Energy pulse</button>
        <button data-action="form">Formation</button>
        <button data-action="dissolve">Dissolve</button>
        <button data-action="rotate">Rotate: Off</button>
      </div>
      ${slider('speed', 'Animation speed', 0.2, 2.5, 0.05, 1, (v) => `${fx(v)}x`)}
    </section>
    <section>
      <h2>Look</h2>
      ${slider('eye', 'Eye glow', 0, 2, 0.01, 1, fx)}
      ${slider('density', 'Particle density', 0.3, 1, 0.01, 1, pct)}
      ${slider('glow', 'Glow strength', 0, 2, 0.01, 0.6, fx)}
      <label class="ra-dev-check"><input type="checkbox" id="bloom" checked /> Bloom</label>
      <label class="ra-dev-row">Graphics quality
        <select id="quality">${h.presetNames.map((n) => `<option value="${n}">${n[0].toUpperCase() + n.slice(1)}</option>`).join('')}</select>
      </label>
    </section>
    <section>
      <h2>Speech</h2>
      ${slider('speech', 'Speech intensity', 0, 1.5, 0.01, 1, fx)}
      <label class="ra-dev-row">Test audio file
        <input type="file" id="audio-file" accept="audio/*" /></label>
      <div class="ra-dev-grid ra-dev-grid-3">
        <button data-action="audio-play" disabled>Play</button>
        <button data-action="audio-pause" disabled>Pause</button>
        <button data-action="audio-stop" disabled>Stop</button>
      </div>
      <label class="ra-dev-check"><input type="checkbox" id="mic" /> Microphone level for listening</label>
      <button class="ra-dev-wide" data-action="tts-test" type="button">Test offline voice line</button>
      <p class="ra-dev-note" id="speech-note">Offline Piper TTS drives the mouth via Web Audio analyser. Browser STT remains for wake/questions.</p>
    </section>
    <section>
      <h2>Diagnostics</h2>
      <pre class="ra-dev-diag" id="ra-pipeline-diag">Waiting for status…</pre>
      <button class="ra-dev-wide" data-action="run-diag" type="button">Run Diagnostics</button>
      <label class="ra-dev-check"><input type="checkbox" id="mock-llm" /> Use mock responses (dev only)</label>
      <p class="ra-dev-note" id="startup-note">Startup: measuring…</p>
    </section>
    <div id="ra-voice-lab-slot"></div>
    <footer id="ra-dev-status" aria-live="polite"></footer>`;
  document.body.append(toggle, root);

  const q = (s) => root.querySelector(s);
  const act = (a) => q(`[data-action="${a}"]`);

  const setOpen = (open) => {
    root.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.classList.toggle('is-open', open);
  };
  const setHidden = (hidden) => {
    toggle.hidden = hidden;
    if (hidden) setOpen(false);
  };
  toggle.onclick = () => setOpen(root.hidden);
  q('.ra-dev-hide').onclick = () => setHidden(true);
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      setHidden(!toggle.hidden);
    }
  });

  root.querySelectorAll('[data-state]').forEach((b) => { b.onclick = () => h.onState(b.dataset.state); });
  root.querySelectorAll('[data-backend-state]').forEach((b) => {
    b.onclick = () => h.onBackendState?.(b.dataset.backendState);
  });
  const backendUrlEl = q('#backend-url');
  if (backendUrlEl && h.backendUrl) backendUrlEl.textContent = h.backendUrl;
  act('demo').onclick = () => h.onDemo();
  act('pulse').onclick = () => h.onPulse();
  act('form').onclick = () => h.onForm();
  act('dissolve').onclick = () => h.onDissolve();
  act('rotate').onclick = () => h.onRotate();
  act('audio-play').onclick = () => h.onAudio('play');
  act('audio-pause').onclick = () => h.onAudio('pause');
  act('audio-stop').onclick = () => h.onAudio('stop');
  act('tts-test').onclick = () => h.onTtsTest?.();
  act('run-diag').onclick = () => h.onRunDiagnostics?.();
  q('#mock-llm').onchange = (e) => h.onMockLlm?.(e.target.checked);

  const bindSlider = (id, fmt, fn) => {
    q(`#${id}`).oninput = (e) => {
      q(`#v-${id}`).textContent = fmt(e.target.value);
      fn(Number(e.target.value));
    };
  };
  bindSlider('speed', (v) => `${fx(v)}x`, h.onSpeed);
  bindSlider('eye', fx, h.onEye);
  bindSlider('density', pct, h.onDensity);
  bindSlider('glow', fx, h.onGlow);
  bindSlider('speech', fx, h.onSpeechIntensity);
  q('#bloom').onchange = (e) => h.onBloom(e.target.checked);
  q('#quality').onchange = (e) => h.onQuality(e.target.value);
  q('#quality').value = h.initialQuality;
  q('#audio-file').onchange = (e) => {
    const file = e.target.files?.[0];
    if (file) h.onAudioFile(file);
  };
  q('#mic').onchange = async (e) => {
    const ok = await h.onMic(e.target.checked);
    if (!ok) e.target.checked = false;
  };

  if (h.startHidden) setHidden(true);

  return {
    getDensity: () => Number(q('#density').value),
    getSpeed: () => Number(q('#speed').value),
    setQuality: (name) => { q('#quality').value = name; },
    setBloom: (on) => { q('#bloom').checked = on; },
    setState: (name) => {
      root.querySelectorAll('[data-state]').forEach((b) => b.classList.toggle('active', b.dataset.state === name));
    },
    setRotate: (on) => {
      act('rotate').textContent = on ? 'Rotate: On' : 'Rotate: Off';
      act('rotate').classList.toggle('active', on);
    },
    setDissolve: (on) => {
      act('dissolve').textContent = on ? 'Reform' : 'Dissolve';
      act('dissolve').classList.toggle('active', on);
    },
    setAudioReady: (ready) => {
      ['audio-play', 'audio-pause', 'audio-stop'].forEach((a) => { act(a).disabled = !ready; });
    },
    setSpeechNote: (text) => { q('#speech-note').textContent = text; },
    setStartupNote: (text) => {
      const el = q('#startup-note');
      if (el) el.textContent = text;
    },
    setPipelineStatus: (diag = {}, patch = {}) => {
      const el = q('#ra-pipeline-diag');
      if (!el) return;
      const micConnected = patch.micPermission === 'granted' || diag.mic === 'connected';
      const wakeActive = !!patch.handsFree && patch.phase !== 'speaking'
        && (patch.wakeStatus === 'armed' || patch.wakeStatus === 'STANDBY-LISTEN'
          || patch.phase === 'sleeping' || patch.phase === 'standby' || patch.phase === 'listening');
      const lines = [
        `MICROPHONE: ${micConnected ? 'Connected' : (patch.micPermission === 'denied' ? 'Denied' : 'Disconnected')}`,
        `WAKE DETECTOR: ${wakeActive ? 'Active' : 'Inactive'}`,
        `STT: ${(diag.stt || '—').toString()}`,
        `BACKEND: ${patch.backendStatus === 'connected' ? 'Connected' : (patch.backendStatus || 'Disconnected')}`,
        `OLLAMA: ${(diag.ollama || 'unknown').toString()}`,
        `MODEL: ${patch.model || diag.model || 'qwen3:1.7b'}`,
        `LLM: ${(diag.llm || 'idle').toString()}`,
        `TTS: ${(diag.tts || 'idle').toString()}`,
        `MEMORY: ${diag.memory || 'Pending'}`,
        `WEBGL: ${patch.webgl === false ? 'Error' : (patch.webgl ? 'Active' : '—')}`,
        `FPS: ${patch.fps != null ? Number(patch.fps).toFixed(0) : '—'}`,
        `STARTUP TIME: ${patch.startupMs != null ? `${Math.round(patch.startupMs)} ms` : '—'}`,
        `PHASE: ${patch.phase || '—'} · SOURCE: ${patch.lastSource || '—'}`,
      ];
      el.textContent = lines.join('\n');
    },
    setStatus: (text) => { q('#ra-dev-status').textContent = text; },
    setBackendConnection: (status) => {
      const pill = q('.ra-backend-pill');
      if (!pill) return;
      const label = {
        connected: 'ONLINE',
        connecting: 'CONNECTING',
        disconnected: 'OFFLINE',
        error: 'ERROR',
      }[status] || String(status).toUpperCase();
      pill.dataset.conn = status;
      pill.textContent = label;
      root.querySelectorAll('[data-backend-state]').forEach((b) => {
        b.disabled = status !== 'connected';
      });
    },
    setOpen,
    mountVoiceLab(el) {
      const slot = q('#ra-voice-lab-slot');
      if (slot && el) slot.replaceChildren(el);
    },
  };
}
