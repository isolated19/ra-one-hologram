import './styles/main.css';
import { SceneManager } from './scene/SceneManager.js';
import { CosmicCharacter } from './character/CosmicCharacter.js';
import { PRESETS } from './particles/ParticleSystem.js';
import { AssistantStateManager } from './state/AssistantStateManager.js';
import { SpeechVisualizer } from './speech/SpeechVisualizer.js';
import { VoiceAmplitudeAnalyzer } from './speech/VoiceAmplitudeAnalyzer.js';
import { RaOneAssistant } from './assistant/RaOneAssistant.js';
import { InteractionSimulator } from './assistant/InteractionSimulator.js';
import { AssistantUI } from './ui/AssistantUI.js';
import { createDebugPanel } from './ui/AssistantDebugPanel.js';
import { createBackendClient } from './api/BackendClient.js';
import { BACKEND_URL } from './api/config.js';
import { VoiceInteractionController } from './assistant/VoiceInteractionController.js';
import { createVoiceSettingsPanel } from './ui/VoiceSettingsPanel.js';
import { createVoiceTestPanel } from './ui/VoiceTestPanel.js';
import { QUALITY_ORDER, probeDevice, choosePreset } from './scene/deviceProfile.js';
import { isDesktop, isPageHidden, onPageVisibility } from './utils/pageVisibility.js';
import { FaceEmotionTracker } from './vision/FaceEmotionTracker.js';

performance.mark('raone-boot-start');

const PRESET_ORDER = QUALITY_ORDER;
const params = new URLSearchParams(location.search);
const isMobile = /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent) || Math.min(innerWidth, innerHeight) < 500;

const app = new SceneManager(document.body);
const state = new AssistantStateManager();
const character = new CosmicCharacter(app.scene, app.camera.fov, state);
const speech = new SpeechVisualizer(character.mouth);
const micAnalyzer = new VoiceAmplitudeAnalyzer({ gain: 8 });
const assistant = new RaOneAssistant({ state, character, speech });

// The full 6.5 s formation plays once per session; reloads get a short version (?intro=1 forces the full one)
const INTRO_KEY = 'raone.formed';
try {
  if (sessionStorage.getItem(INTRO_KEY) && params.get('intro') !== '1') character.formation.duration = 1.8;
} catch { /* storage blocked: always play the full intro */ }
// Lite mode has no 3D formation to watch
if (!app.supported) character.formation.duration = 0.6;

// Start from what the machine can do (no GPU → Minimal). A setting the adaptive monitor
// or the DEV panel chose is remembered per browser; ?quality=auto forgets it.
const QUALITY_KEY = 'raone.quality';
const storage = {
  get: () => { try { return localStorage.getItem(QUALITY_KEY); } catch { return null; } },
  set: (v) => { try { localStorage.setItem(QUALITY_KEY, v); } catch { /* ignore */ } },
  clear: () => { try { localStorage.removeItem(QUALITY_KEY); } catch { /* ignore */ } },
};
if (params.get('quality') === 'auto') storage.clear();
const device = probeDevice({ mobile: isMobile });

let quality = choosePreset(device, { forced: params.get('quality'), saved: storage.get() });
let bloomOn = true;
const perf = {
  fps: 0,
  sinceApply: 0,
  acc: 0,
  frames: 0,
  lowWindows: 0,
  scaleFloor: false,
  startupMs: null,
  firstFrameMs: null,
};

// ---------------------------------------------------------------- UI

const backend = createBackendClient({ autoConnect: true });

/** Filled after UI/debug exist — voice callbacks close over this bag. */
const uiBag = { panel: null, ui: null, debug: null, simulator: null };

const voice = new VoiceInteractionController({
  assistant,
  speech,
  character,
  backend,
  onUi: (patch) => {
    uiBag.panel?.update(patch);
    if (patch.phase || patch.uiStatus) {
      const statusKey = patch.phase === 'sleeping' ? 'sleeping'
        : patch.uiStatus === 'WAKE DETECTED' ? 'wake_detected'
        : (patch.phase || 'idle');
      uiBag.ui?.setStatus(statusKey);
      uiBag.ui?.setMicActive(
        voice.handsFree && (patch.phase === 'listening' || patch.phase === 'standby' || patch.phase === 'sleeping'),
      );
    }
    if (patch.response) {
      uiBag.ui?.setReply(patch.response, {
        simulated: !!patch.simulated,
        pending: patch.phase === 'thinking' || patch.phase === 'listening',
      });
    }
    if (patch.error) uiBag.debug?.setSpeechNote(patch.error);
    if (patch.diagnostics) {
      uiBag.debug?.setPipelineStatus?.(patch.diagnostics, {
        ...patch,
        backendStatus: backend.status,
        webgl: app.supported,
        fps: perf.fps,
        startupMs: perf.startupMs,
        model: patch.model || voice.diagnostics.model,
      });
    }
  },
});

const voicePanel = createVoiceSettingsPanel({
  onToggleHandsFree: async () => {
    try {
      if (voice.handsFree) voice.disableHandsFree();
      else {
        uiBag.simulator?.cancel({ toIdle: false });
        await voice.enableHandsFree();
        uiBag.ui?.setReply("Hands-free on. RA-ONE is sleeping — clap or say “Hey RA-ONE”.", { pending: true });
        uiBag.ui?.setStatus('sleeping');
      }
    } catch (err) {
      uiBag.ui?.setReply(`Microphone: ${err.message}`, { pending: true });
      voicePanel.update({ micPermission: voice.micPermission, handsFree: false });
    }
  },
  onDisableHandsFree: () => {
    voice.disableHandsFree();
    uiBag.ui?.setReply('Hands-free disabled. Microphone released.', { pending: true });
    uiBag.ui?.setMicActive(false);
    refreshStatus();
  },
  onTtsEnabled: (on) => voice.setTtsEnabled(on),
  onSpeechRate: (v) => voice.setSpeechRate(v),
  onClapSensitivity: (v) => voice.setClapSensitivity(v),
});
uiBag.panel = voicePanel;

const ui = new AssistantUI({
  onSend: (text) => {
    uiBag.simulator?.cancel({ toIdle: false });
    // Typed and spoken turns share one pipeline; history fills from voice 'turn' events
    voice.handleTextQuestion(text);
  },
  onMic: async () => {
    // Mic button now enables/disables hands-free (not per-turn capture)
    try {
      if (voice.handsFree) voice.disableHandsFree();
      else {
        uiBag.simulator?.cancel({ toIdle: false });
        await voice.enableHandsFree();
        ui.setReply("Hands-free on. Say “Hey RA-ONE” or clap.", { pending: true });
      }
    } catch (err) {
      ui.setReply(`Microphone: ${err.message}`, { pending: true });
    }
  },
  onCancel: () => {
    uiBag.simulator?.cancel();
    voice.cancel();
  },
  onCamera: () => toggleCamera(),
});
uiBag.ui = ui;
ui.mountVoicePanel(voicePanel.el);
voice.on('turn', ({ role, text, via, simulated }) => ui.history.add(role, text, { via, simulated }));
voicePanel.update({
  handsFree: true,
  micPermission: 'unknown',
  wakeStatus: 'starting',
  ttsEnabled: true,
  speechRate: 1,
  clapSensitivity: 0.55,
});

/** Hands-free stays on by default; browsers may still need one gesture for mic permission. */
async function ensureHandsFreeDefault() {
  if (voice.handsFree && voice.session.isActive) return true;
  try {
    uiBag.simulator?.cancel({ toIdle: false });
    await voice.enableHandsFree();
    voicePanel.update({
      handsFree: true,
      micPermission: voice.micPermission,
      wakeStatus: voice.wakeStatus,
    });
    ui.setStatus('sleeping');
    ui.setMicActive(true);
    return true;
  } catch (err) {
    voicePanel.update({ micPermission: voice.micPermission, handsFree: false });
    ui.setReply(`Hands-free needs microphone access: ${err.message}. Click anywhere or tap the mic to allow.`, {
      pending: true,
    });
    return false;
  }
}

function armHandsFreeOnFirstGesture() {
  const once = async () => {
    window.removeEventListener('pointerdown', once);
    window.removeEventListener('keydown', once);
    if (voice.handsFree && voice.session.isActive) return;
    const ok = await ensureHandsFreeDefault();
    if (ok) {
      ui.setReply('Hands-free on. RA-ONE is sleeping — clap or say “Hey RA-ONE”.', { pending: true });
    }
  };
  window.addEventListener('pointerdown', once, { once: true });
  window.addEventListener('keydown', once, { once: true });
}

const simulator = new InteractionSimulator(assistant, character.listening, {
  onUserMessage: (text) => {
    ui.history.add('user', text);
    ui.setReply(`“${text}”`, { pending: true });
  },
  onReplyProgress: (partial) => ui.setReply(partial, { simulated: true }),
  onReplyEnd: (text) => ui.history.add('ra', text, { simulated: true }),
  onCancel: () => ui.setReply('Interaction cancelled.', { pending: true }),
});
uiBag.simulator = simulator;

const debug = createDebugPanel({
  presetNames: PRESET_ORDER,
  initialQuality: quality,
  startHidden: params.get('dev') === '0',
  backendUrl: BACKEND_URL,
  onState: (name) => {
    simulator.cancel({ toIdle: false });
    voice.cancel();
    assistant.setState(name, { source: 'debug' });
    if (name === 'speaking' && speech.mode !== 'audio' && speech.mode !== 'external') speech.startDemo();
  },
  onBackendState: async (name) => {
    simulator.cancel({ toIdle: false });
    try {
      // Optimistic local update; WebSocket echo keeps peers in sync
      assistant.setState(name, { source: 'backend-dev' });
      if (name === 'speaking' && speech.mode !== 'audio' && speech.mode !== 'external') speech.startDemo();
      await backend.setRemoteState(name, 'debug-panel');
    } catch (err) {
      debug.setSpeechNote(`Backend state failed: ${err.message}`);
    }
  },
  onDemo: () => simulator.run({ text: 'Hello RA-ONE', voice: true }),
  onTtsTest: () => {
    voice.setVoicePreset(voice.voicePreset || 'raone_jarvis');
    voice.testVoice('I am RA-ONE. My systems are now online.').catch((e) => {
      uiBag.debug?.setSpeechNote(`Offline voice: ${e.message}`);
    });
  },
  onMockLlm: (on) => {
    voice.setUseMockResponses(on);
    debug.setSpeechNote(on ? 'Mock responses ON (dev).' : 'Using real local LLM when Ollama is online.');
  },
  onRunDiagnostics: async () => {
    const lines = [];
    lines.push(`WebGL: ${app.supported ? 'Active' : 'Unavailable (lite)'}`);
    lines.push(`FPS: ${perf.fps ? perf.fps.toFixed(0) : '—'}`);
    lines.push(`Startup: ${perf.startupMs != null ? `${Math.round(perf.startupMs)} ms` : '—'}`);
    lines.push(`Mic: ${voice.micPermission} · Hands-free: ${voice.handsFree ? 'on' : 'off'}`);
    lines.push(`Wake: ${voice.wakeStatus} · Phase: ${voice.phase}`);
    let modelName = 'qwen3:1.7b';
    try {
      const h = await voice.conversation.health();
      modelName = h.selected_model || modelName;
      lines.push(`Ollama: ${h.ollama_reachable ? 'Online' : 'Offline'}`);
      lines.push(`Model: ${modelName} · pref=${h.preferred_installed} fall=${h.fallback_installed}`);
      voice.diagnostics.ollama = h.ollama_reachable ? 'online' : 'offline';
      voice.diagnostics.model = modelName;
      if (!h.ollama_reachable) {
        lines.push('FAIL: Start Ollama (setup_ollama.ps1)');
      } else if (!h.preferred_installed && !h.fallback_installed) {
        lines.push('FAIL: Pull qwen3:1.7b or qwen3:0.6b');
      }
    } catch (e) {
      lines.push(`Ollama/API: ${e.message}`);
      voice.diagnostics.ollama = 'error';
    }
    lines.push(`Backend WS: ${backend.status}`);
    debug.setSpeechNote(lines.join(' · '));
    debug.setPipelineStatus(voice.diagnostics, {
      micPermission: voice.micPermission,
      handsFree: voice.handsFree,
      wakeStatus: voice.wakeStatus,
      phase: voice.phase,
      lastSource: voice.lastSource,
      fps: perf.fps,
      startupMs: perf.startupMs,
      backendStatus: backend.status,
      webgl: app.supported,
      model: modelName,
    });
  },
  onPulse: () => assistant.playEnergyPulse(),
  onForm: () => {
    assistant.form();
    debug.setDissolve(false);
    refreshStatus();
  },
  onDissolve: () => {
    debug.setDissolve(assistant.dissolve());
    refreshStatus();
  },
  onRotate: () => {
    character.rotateOn = !character.rotateOn;
    debug.setRotate(character.rotateOn);
  },
  onSpeed: (v) => character.setSpeed(v),
  onEye: (v) => character.eyes.setGain(v),
  onDensity: (v) => character.setDensity(v),
  onGlow: (v) => app.setBloomStrength(v),
  onBloom: (on) => {
    bloomOn = on;
    app.setBloom(on);
  },
  onQuality: (name) => {
    perf.lowWindows = 0;
    storage.set(name);
    applyQuality(name);
  },
  onSpeechIntensity: (v) => speech.setIntensity(v),
  onAudioFile: (file) => {
    speech.loadTestAudio(file);
    debug.setAudioReady(true);
    debug.setSpeechNote(`Loaded “${file.name}”. Play drives the mouth from its real amplitude.`);
  },
  onAudio: async (cmd) => {
    if (cmd === 'play') {
      simulator.cancel({ toIdle: false });
      try {
        await speech.playTestAudio();
        assistant.setState('speaking', { source: 'test-audio' });
      } catch (e) {
        debug.setSpeechNote(`Could not play audio: ${e.message}`);
      }
    } else {
      if (cmd === 'pause') speech.pauseTestAudio(); else speech.stopTestAudio();
      if (state.getState() === 'speaking') assistant.setState('idle');
    }
  },
  onMic: async (on) => {
    if (!on) {
      micAnalyzer.disconnect();
      character.listening.setInputAnalyzer(null);
      debug.setSpeechNote('Listening uses simulated input.');
      return true;
    }
    try {
      await micAnalyzer.enableMicrophone();
      character.listening.setInputAnalyzer(micAnalyzer);
      debug.setSpeechNote('Microphone level drives the listening animation (no speech recognition).');
      return true;
    } catch (e) {
      debug.setSpeechNote(`Microphone unavailable: ${e.message}`);
      return false;
    }
  },
});
uiBag.debug = debug;

function refreshStatus() {
  if (!assistant.ready) ui.setStatus('initializing');
  else if (assistant.dissolved) ui.setStatus('dissolved');
  else if (voice.handsFree) {
    const map = {
      sleeping: 'sleeping',
      standby: 'standby',
      listening: 'listening',
      thinking: 'thinking',
      speaking: 'speaking',
      error: 'error',
    };
    ui.setStatus(map[voice.phase] || state.getState());
  } else ui.setStatus(state.getState());
}

state.on('change', ({ from, to }) => {
  refreshStatus();
  debug.setState(to);
  app.setFallbackState(to);
  if (!voice.handsFree) ui.setMicActive(to === 'listening');
  // Leaving SPEAKING always quiets the mouth, whatever started it
  if (from === 'speaking') {
    if (speech.mode === 'demo') speech.stop();
    if (speech.mode === 'audio') speech.pauseTestAudio();
    if (speech.mode === 'external') speech.setExternalAmplitude(null);
  }
  // Subtle eye energy while speaking (offline WAV amplitude also drives mouth)
  if (to === 'speaking' && !character.sleepFx?.active) character.eyes.setGain?.(1.15);
  if (from === 'speaking' && !character.sleepFx?.active) character.eyes.setGain?.(1);
});
speech.on('test-audio', (event) => {
  if (event === 'ended' && state.getState() === 'speaking') assistant.setState('idle');
});
let handsFreeBooted = false;
function bootHandsFree() {
  if (handsFreeBooted) return;
  handsFreeBooted = true;
  const lite = app.supported ? '' : ' Lite mode: this device can’t run the 3D view, but voice and chat work normally.';
  // Never block hologram/interaction on mic permission — request asynchronously
  ui.setReply(`Systems online. Enabling hands-free… You can type anytime.${lite}`, { pending: true });
  void ensureHandsFreeDefault().then((ok) => {
    if (ok) {
      ui.setReply(`Systems online. Hands-free is on — clap or say “Hey RA-ONE”. You can also type.${lite}`, { pending: true });
    } else {
      armHandsFreeOnFirstGesture();
      ui.setReply(`Systems online. Click once to enable the mic for hands-free, then clap or say “Hey RA-ONE”.${lite}`, {
        pending: true,
      });
    }
  });
}
assistant.on('ready', () => {
  try { sessionStorage.setItem(INTRO_KEY, '1'); } catch { /* ignore */ }
  refreshStatus();
  bootHandsFree();
});
// Desktop app: listen from launch (the intro is only visual). Browser started minimised:
// the formation runs in the paused render loop and would never reach 'ready'.
if (isDesktop || isPageHidden()) bootHandsFree();
else {
  const off = onPageVisibility((hidden) => {
    if (!hidden) return;
    off();
    bootHandsFree();
  });
}
debug.setState(state.getState());
debug.setBackendConnection(backend.status);

// Offline Piper voice lab (DEV panel)
const voiceLab = createVoiceTestPanel({
  onGenerate: async (cfg) => {
    try {
      voiceLab.setStatus('Generating offline speech…');
      voice.setVoicePreset(cfg.preset);
      const { meta } = await voice.offlineVoice.synthesize(cfg.text, {
        preset: cfg.preset,
        voice_id: cfg.voice_id,
        overrides: cfg.overrides,
      });
      voiceLab.setReady(true);
      voiceLab.setStatus(
        `Ready · ${meta.preset} · ${meta.voiceId} · ${meta.latencyMs?.toFixed?.(0) ?? meta.latencyMs} ms · peak ${meta.peak?.toFixed?.(2) ?? meta.peak}${meta.clipped ? ' · CLIPPED' : ''}`,
      );
    } catch (err) {
      voiceLab.setReady(false);
      voiceLab.setStatus(`Generate failed: ${err.message}`);
    }
  },
  onPlay: async () => {
    try {
      simulator.cancel({ toIdle: false });
      voice.cancel();
      assistant.setState('speaking', { source: 'voice-lab' });
      await voice.offlineVoice.playBlob(voice.offlineVoice.lastWav, {
        onEnd: () => {
          if (state.getState() === 'speaking') assistant.setState('idle');
        },
      });
    } catch (err) {
      voiceLab.setStatus(`Play failed: ${err.message}`);
      assistant.setState('idle');
    }
  },
  onStop: () => {
    voice.offlineVoice.stop();
    if (state.getState() === 'speaking') assistant.setState('idle');
    voiceLab.setStatus('Stopped.');
  },
  onDownload: () => {
    try {
      voice.offlineVoice.downloadLast(`raone-${voice.voicePreset || 'voice'}.wav`);
    } catch (err) {
      voiceLab.setStatus(err.message);
    }
  },
});
debug.mountVoiceLab(voiceLab.el);
voice.offlineVoice.fetchPresets()
  .then((data) => {
    voiceLab.setPresets(data.presets || [], data.default_preset || 'raone_jarvis');
    voiceLab.setVoices(data.installed_voices || []);
    voiceLab.setStatus(`Piper online · ${(data.installed_voices || []).length} model(s)`);
  })
  .catch(() => voiceLab.setStatus('Voice API offline — start the FastAPI backend.'));

// Module 1: sync hologram UI from FastAPI WebSocket without a second state manager
backend.on('connection', ({ status }) => {
  debug.setBackendConnection(status);
  const cfg = PRESETS[quality];
  const count = character.system?.count ?? cfg.total;
  const link = status === 'connected' ? ' · backend online' : ` · backend ${status}`;
  debug.setStatus(`${cfg.name} · ${count.toLocaleString()} particles · ${perf.fps ? perf.fps.toFixed(0) : '–'} fps${link}`);
});

backend.on('assistant.state', (event) => {
  if (event.source === 'debug-panel' && state.getState() === event.state) return;
  // Avoid fighting the local voice pipeline / echoing our own voice sync
  if (event.source === 'voice' || voice.phase === 'listening' || voice.phase === 'thinking' || voice.phase === 'speaking') {
    return;
  }
  simulator.cancel({ toIdle: false });
  assistant.setState(event.state, { source: 'backend', timestamp: event.timestamp });
  if (event.state === 'speaking' && speech.mode !== 'audio' && speech.mode !== 'external') {
    speech.startDemo();
  }
});

backend.on('error', ({ message }) => {
  console.warn('[RA-ONE backend]', message);
});

if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  character.idle.reducedMotion = true;
  character.setSpeed(0.8);
  character.lookStrength = 0.4;
}

// Gaze follows the pointer; after a few idle seconds (or when it leaves) RA-ONE looks ahead again
let gazeTimer = 0;
addEventListener('pointermove', (e) => {
  character.lookAt((e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2);
  clearTimeout(gazeTimer);
  gazeTimer = setTimeout(() => character.lookAt(0, 0), 4000);
});
document.documentElement.addEventListener('pointerleave', () => character.lookAt(0, 0));

// ---------------------------------------------------------------- camera: face tracking + mood
// On with hands-free by default; the Cam chip turns it off and the choice is remembered.
// Off whenever the window is hidden, so the camera light never stays on behind the tray.
const CAMERA_KEY = 'raone.camera';
const tracker = new FaceEmotionTracker();
let cameraWanted = (() => {
  try { return localStorage.getItem(CAMERA_KEY) !== 'off'; } catch { return true; }
})();
voice.setMoodProvider(() => tracker.mood());

async function startCamera() {
  if (tracker.active || !FaceEmotionTracker.isSupported()) return;
  try {
    await tracker.start();
  } catch (err) {
    debug.setSpeechNote(`Camera: ${err.message}`);
  }
}

function syncCamera() {
  if (cameraWanted && voice.handsFree && !isPageHidden()) void startCamera();
  else tracker.stop();
}

function toggleCamera() {
  cameraWanted = !(cameraWanted && tracker.active);
  try { localStorage.setItem(CAMERA_KEY, cameraWanted ? 'on' : 'off'); } catch { /* ignore */ }
  if (cameraWanted && !voice.handsFree) {
    // Camera rides along with hands-free; bring that up too
    void ensureHandsFreeDefault().then(syncCamera);
  } else {
    syncCamera();
  }
}

tracker.on('state', ({ active, error }) => {
  ui.setCamera({ active, error, present: tracker.current.present, emotion: tracker.stableEmotion });
  if (!active) character.lookAt(0, 0);
});

let faceGazing = false;
tracker.on('face', ({ present, x, y }) => {
  ui.setCamera({ active: tracker.active, present, emotion: tracker.stableEmotion });
  if (present) {
    // Look at the user, a little short of the edge so the eyes don't strain
    character.lookAt(x * 0.8, y * 0.6);
    faceGazing = true;
  } else if (faceGazing) {
    character.lookAt(0, 0);
    faceGazing = false;
  }
});

// A friend notices when you look down. Speak up only after the mood holds for a while,
// only while awake in standby, and at most once every 10 minutes.
const CHECK_IN_LINES = {
  sad: ["Hey, you seem a little down. Want to talk about it? I'm here.", 'You look like something is bothering you. Anything I can do?'],
  angry: ["You look frustrated, sir. Want me to help sort it out?"],
  fearful: ["You seem worried. Everything alright? I'm right here."],
};
const CHECK_IN_COOLDOWN_MS = 10 * 60 * 1000;
let lastCheckInAt = -Infinity;
let checkInTimer = 0;
tracker.on('emotion', ({ emotion }) => {
  clearTimeout(checkInTimer);
  const lines = CHECK_IN_LINES[emotion];
  if (!lines) return;
  checkInTimer = setTimeout(async () => {
    if (tracker.stableEmotion !== emotion || performance.now() - lastCheckInAt < CHECK_IN_COOLDOWN_MS) return;
    const line = lines[Math.floor(Math.random() * lines.length)];
    if (await voice.checkIn(line)) lastCheckInAt = performance.now();
  }, 6000);
});

// Diagnostics handle for DevTools (inspect camera / voice state in the running app)
window.__raone = { voice, tracker, ui };

voice.on('handsFree', syncCamera);
// Speech-to-text and the LLM share this CPU: stop face detection while they work
voice.on('phase', ({ to }) => tracker.setPaused(to === 'listening' || to === 'thinking'));
onPageVisibility(syncCamera);
ui.setCamera({ active: false });

// ---------------------------------------------------------------- quality & layout

function setPerfStatus(extra = '') {
  const cfg = PRESETS[quality];
  const count = character.system?.count ?? cfg.total;
  const mode = app.supported ? '' : ' · lite (no WebGL)';
  debug.setStatus(`${cfg.name} · ${count.toLocaleString()} particles · ${perf.fps ? perf.fps.toFixed(0) : '–'} fps${mode}${extra}`);
}

/** Frame cap: the preset's, or 15 fps in lite mode where only state and UI animate. */
function fpsCap() {
  return app.supported ? PRESETS[quality].fpsCap : 15;
}

function applyQuality(name, { deferParticles = false, progressive = false } = {}) {
  quality = name;
  const cfg = PRESETS[name];
  app.setPixelRatio(cfg.maxPixelRatio);
  app.setBloom(bloomOn && cfg.bloom, cfg.bloomScale * (isMobile ? 0.8 : 1));
  app.setAntialias(cfg.smaa);
  perf.scaleFloor = false;
  const buildParticles = (presetName) => {
    const pCfg = PRESETS[presetName];
    performance.mark('raone-particles-start');
    character.setPreset(presetName);
    character.uniforms.uBrightness.value = pCfg.bloom ? 1 : pCfg.brightness ?? 1;
    character.setViewport(innerHeight, app.pixelRatio);
    character.setDensity(debug.getDensity());
    character.setSpeed(debug.getSpeed());
    performance.mark('raone-particles-end');
    try {
      performance.measure('raone-particles', 'raone-particles-start', 'raone-particles-end');
      const m = performance.getEntriesByName('raone-particles').at(-1);
      if (m) console.info(`[RA-ONE] particles ${presetName}: ${Math.round(m.duration)} ms`);
    } catch { /* ignore */ }
  };
  // First paint: light preset for hologram, then upgrade to target without blocking interaction
  const needsRamp = progressive && !character.system
    && (name === 'medium' || name === 'high');
  if (deferParticles && !character.system) {
    requestAnimationFrame(() => {
      buildParticles(needsRamp ? 'low' : name);
      setPerfStatus(needsRamp ? ' · ramping quality' : '');
      if (needsRamp) {
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (quality !== name) return; // user changed preset
            buildParticles(name);
            setPerfStatus();
          }, 50);
        });
      }
    });
  } else {
    buildParticles(name);
  }
  debug.setQuality(name);
  perf.sinceApply = 0;
  setPerfStatus();
}

// Adaptive quality: after warm-up, step down a preset whenever the frame rate stays low
// (High → Medium → Low → Minimal, remembered for next time); on Minimal, render at half
// resolution as the last resort. With a frame cap, "low" is measured against the cap.
function monitorPerformance(dt) {
  perf.sinceApply += dt;
  perf.acc += dt;
  perf.frames++;
  if (perf.acc < 1) return;
  perf.fps = perf.frames / perf.acc;
  perf.acc = 0;
  perf.frames = 0;
  setPerfStatus();
  if (perf.sinceApply < 5 || !assistant.ready || !app.supported) return;
  const floor = fpsCap() ? fpsCap() * 0.75 : 28;
  perf.lowWindows = perf.fps < floor ? perf.lowWindows + 1 : 0;
  if (perf.lowWindows < 3) return;
  perf.lowWindows = 0;
  const idx = PRESET_ORDER.indexOf(quality);
  if (idx < PRESET_ORDER.length - 1) {
    applyQuality(PRESET_ORDER[idx + 1]);
    storage.set(quality);
    setPerfStatus(' · auto-lowered');
  } else if (!perf.scaleFloor) {
    perf.scaleFloor = true;
    app.setPixelRatio(0.5);
    character.setViewport(innerHeight, app.pixelRatio);
    perf.sinceApply = 0;
    setPerfStatus(' · half resolution (auto)');
  }
}

function layout() {
  app.setInsets(ui.insets());
  character.setViewport(innerHeight, app.pixelRatio);
}

applyQuality(quality, { deferParticles: true, progressive: true });
app.setBloomStrength(0.6);
layout();
addEventListener('resize', layout);
new ResizeObserver(layout).observe(ui.top);

// Non-blocking LLM readiness (never delay first paint)
void voice.conversation.health().then((h) => {
  voice.diagnostics.ollama = h.ollama_reachable ? 'online' : 'offline';
  voice.diagnostics.model = h.selected_model || 'qwen3:1.7b';
  const installState = h.ollama_install?.state;
  if (!h.ollama_reachable && ['checking', 'installing', 'starting', 'started'].includes(installState)) {
    debug.setSpeechNote('Ollama missing — installing and starting it automatically…');
  } else if (!h.ollama_reachable) {
    debug.setSpeechNote('Ollama offline — install/start via backend/scripts/setup_ollama.ps1');
  } else if (installState === 'pulling-model') {
    debug.setSpeechNote('Downloading qwen3:1.7b in the background — replies get more natural once it lands');
  } else if (!h.preferred_installed && !h.fallback_installed) {
    debug.setSpeechNote('Ollama online but no Qwen3 model — pull qwen3:1.7b or qwen3:0.6b');
  } else {
    debug.setSpeechNote(`Local LLM ready: ${h.selected_model}`);
  }
  debug.setPipelineStatus(voice.diagnostics, {
    micPermission: voice.micPermission,
    handsFree: voice.handsFree,
    wakeStatus: voice.wakeStatus,
    phase: voice.phase,
    backendStatus: backend.status,
    webgl: app.supported,
    fps: perf.fps,
    startupMs: perf.startupMs,
    model: h.selected_model,
  });
}).catch(() => {
  voice.diagnostics.ollama = 'error';
});

// ---------------------------------------------------------------- frame loop

let last = performance.now();
let elapsed = 0;
let rafId = 0;

function frame(now) {
  // Capped presets skip frames until enough time has passed (2 ms slack for vsync jitter)
  const cap = fpsCap();
  if (cap && now - last < 1000 / cap - 2) {
    rafId = requestAnimationFrame(frame);
    return;
  }
  // Clamp large gaps, but loosely enough that slow machines still finish animations in real time
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  elapsed += dt;
  if (perf.firstFrameMs == null) {
    perf.firstFrameMs = performance.now();
    try {
      performance.mark('raone-first-frame');
      performance.measure('raone-boot-to-frame', 'raone-boot-start', 'raone-first-frame');
      const m = performance.getEntriesByName('raone-boot-to-frame')[0];
      perf.startupMs = m?.duration ?? (perf.firstFrameMs);
      debug.setStartupNote?.(
        `Startup to first frame: ${Math.round(perf.startupMs)} ms · particles build async`,
      );
    } catch {
      perf.startupMs = perf.firstFrameMs;
    }
  }
  state.update(dt);
  speech.update(dt);
  voice.update();
  character.update(dt, elapsed, app.cameraController.currentDistance);
  app.render();
  monitorPerformance(dt);
  rafId = requestAnimationFrame(frame);
}

function start() {
  cancelAnimationFrame(rafId);
  last = performance.now();
  rafId = requestAnimationFrame(frame);
}

// Pause entirely while the tab / desktop window is hidden (audio keeps running)
onPageVisibility((hidden) => {
  if (hidden) cancelAnimationFrame(rafId);
  else start();
});
if (!isPageHidden()) start();

// Public interface for a future AI layer (see RaOneAssistant.js)
window.RAONE = assistant;
assistant.debug = { simulator, speech, micAnalyzer, perf, applyQuality, backend, voice, device };
assistant.backend = backend;
assistant.voice = voice;
