/**
 * Developer voice lab for offline Piper TTS + cinematic presets.
 */
export function createVoiceTestPanel(handlers = {}) {
  const root = document.createElement('section');
  root.className = 'ra-voice-lab';
  root.setAttribute('aria-label', 'Offline voice testing');
  root.innerHTML = `
    <h2>Offline Voice Engine</h2>
    <label class="ra-dev-row">Test line
      <textarea id="vt-text" rows="3" maxlength="800">I am RA-ONE. My systems are now online.</textarea>
    </label>
    <label class="ra-dev-row">Voice model
      <select id="vt-voice"></select>
    </label>
    <label class="ra-dev-row">Preset
      <select id="vt-preset"></select>
    </label>
    <label class="ra-dev-row">Pitch (semitones) <output id="vt-pitch-o">0.0</output>
      <input type="range" id="vt-pitch" min="-6" max="2" step="0.1" value="0" />
    </label>
    <label class="ra-dev-row">Speaking speed <output id="vt-speed-o">1.00</output>
      <input type="range" id="vt-speed" min="0.7" max="1.2" step="0.01" value="1" />
    </label>
    <label class="ra-dev-row">Bass <output id="vt-bass-o">0.0</output>
      <input type="range" id="vt-bass" min="0" max="8" step="0.1" value="0" />
    </label>
    <label class="ra-dev-row">Distortion <output id="vt-sat-o">0.00</output>
      <input type="range" id="vt-sat" min="0" max="0.6" step="0.01" value="0" />
    </label>
    <label class="ra-dev-row">Echo / reverb <output id="vt-rev-o">0.00</output>
      <input type="range" id="vt-rev" min="0" max="0.55" step="0.01" value="0" />
    </label>
    <div class="ra-dev-grid ra-dev-grid-3">
      <button type="button" data-vt="generate">Generate</button>
      <button type="button" data-vt="play" disabled>Play</button>
      <button type="button" data-vt="stop">Stop</button>
    </div>
    <button type="button" class="ra-dev-wide" data-vt="download" disabled>Download WAV</button>
    <p class="ra-dev-note" id="vt-status">Offline Piper TTS — generate before play.</p>
  `;

  const q = (s) => root.querySelector(s);
  const bindOut = (id, out, fmt) => {
    q(`#${id}`).oninput = (e) => {
      q(`#${out}`).textContent = fmt(e.target.value);
    };
  };
  bindOut('vt-pitch', 'vt-pitch-o', (v) => Number(v).toFixed(1));
  bindOut('vt-speed', 'vt-speed-o', (v) => Number(v).toFixed(2));
  bindOut('vt-bass', 'vt-bass-o', (v) => Number(v).toFixed(1));
  bindOut('vt-sat', 'vt-sat-o', (v) => Number(v).toFixed(2));
  bindOut('vt-rev', 'vt-rev-o', (v) => Number(v).toFixed(2));

  q('[data-vt="generate"]').onclick = () => handlers.onGenerate?.(readState());
  q('[data-vt="play"]').onclick = () => handlers.onPlay?.();
  q('[data-vt="stop"]').onclick = () => handlers.onStop?.();
  q('[data-vt="download"]').onclick = () => handlers.onDownload?.();

  function readState() {
    return {
      text: q('#vt-text').value.trim(),
      voice_id: q('#vt-voice').value || null,
      preset: q('#vt-preset').value,
      overrides: {
        pitch_semitones: Number(q('#vt-pitch').value),
        speed: Number(q('#vt-speed').value),
        bass_gain_db: Number(q('#vt-bass').value),
        saturation: Number(q('#vt-sat').value),
        reverb_mix: Number(q('#vt-rev').value),
      },
    };
  }

  return {
    el: root,
    readState,
    setStatus(text) {
      q('#vt-status').textContent = text;
    },
    setReady(ready) {
      q('[data-vt="play"]').disabled = !ready;
      q('[data-vt="download"]').disabled = !ready;
    },
    setVoices(voices = []) {
      const sel = q('#vt-voice');
      sel.innerHTML = voices.map((v) => `<option value="${v.id}">${v.id}</option>`).join('')
        || '<option value="">(no models)</option>';
    },
    setPresets(presets = [], selected = 'raone_jarvis') {
      const sel = q('#vt-preset');
      sel.innerHTML = presets.map((p) => `<option value="${p.id}">${p.label || p.id}</option>`).join('');
      sel.value = selected;
      sel.onchange = () => {
        const p = presets.find((x) => x.id === sel.value);
        if (!p?.params) return;
        const map = [
          ['vt-pitch', 'pitch_semitones'],
          ['vt-speed', 'speed'],
          ['vt-bass', 'bass_gain_db'],
          ['vt-sat', 'saturation'],
          ['vt-rev', 'reverb_mix'],
        ];
        for (const [id, key] of map) {
          if (p.params[key] == null) continue;
          const el = q(`#${id}`);
          el.value = p.params[key];
          el.dispatchEvent(new Event('input'));
        }
        if (p.voice_id) q('#vt-voice').value = p.voice_id;
      };
      sel.dispatchEvent(new Event('change'));
    },
  };
}
