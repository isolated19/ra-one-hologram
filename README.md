# RA-ONE — Cosmic Holographic AI Assistant UI

A real-time Three.js hologram of a hooded cosmic entity, wrapped in a cinematic assistant console.
Conversations are still simulated on the frontend. **Module 1** adds a FastAPI backend that streams
assistant state (`idle` / `listening` / `thinking` / `speaking`) over WebSocket so the hologram
stays in sync. Speech recognition, LLM reasoning, and TTS are not included yet.

## Run

Terminal 1 — frontend:

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build into dist/
npm run preview  # serve the production build
```

Terminal 2 — backend (Module 1):

```bash
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
py -3.12 -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Backend: `http://localhost:8000` · WebSocket: `ws://localhost:8000/ws/assistant`  
Configure with `backend/.env` and frontend `VITE_BACKEND_URL` (see `backend/README.md`).

### Desktop app (Electron)

```bash
npm run desktop            # builds the UI, starts the backend, opens the RA-ONE window + tray icon
npm run desktop:dev        # same, but loads the Vite dev server (run `npm run dev` first)
```

Closing the window hides it to the tray; RA-ONE keeps listening for a clap or "Hey RA-ONE".
Tray → **Quit RA-ONE** stops everything. Details: `docs/DESKTOP_BUILD_PLAN.md` (Modules 3–5).

### Module 2 — hands-free voice

1. Open the app, click **Hands-Free: Off** (or the mic button) once and allow the microphone.
2. Say **Hey RA-ONE** or clap once → LISTENING.
3. Ask a test question (e.g. “Who are you?”). RA-ONE replies with a **predefined** answer via browser TTS.
4. After speaking, it returns to standby and keeps listening for the next wake/clap — no new mic click.
5. Toggle Hands-Free off to release the microphone.

Frontend unit tests: `npm test` · Manual acoustic checklist: `docs/MODULE2_MANUAL_CHECKLIST.md`

### Offline cinematic voice (Piper)

```bash
cd backend
pip install -r requirements.txt
python scripts/download_piper_voices.py   # install-time only
python scripts/verify_offline_tts.py
```

API: `POST /api/voice/synthesize`, `GET /api/voice/presets`, `GET /api/voice/status`  
DEV panel → **Offline Voice Engine** (generate / play / download WAV). Hands-free replies use Piper when the backend is up.

### Graphics adapt to the machine

On load RA-ONE checks the hardware and picks a preset: **Medium** for a dedicated GPU, **Low** for integrated GPUs,
mobiles and mid-range machines, **Minimal** when there is no usable GPU (CPU/software rendering such as SwiftShader,
llvmpipe or Microsoft Basic Render Driver, a VM or remote desktop) or under 2 GB RAM / 2 cores. Minimal drops bloom, the
halo and anti-aliasing, renders below native resolution and caps at 30 fps. While running, if the frame rate stays
low it steps down (High → Medium → Low → Minimal → half resolution) and remembers that choice for the next visit.
Without WebGL at all, a lightweight 2D emblem replaces the 3D view and voice/chat keep working.

URL options: `?quality=minimal|low|medium|high` forces a preset (`?quality=auto` forgets the remembered one); `?dev=0` starts with the developer panel hidden;
`?backend=http://localhost:8000` overrides the API base URL; `?intro=1` replays the full formation (reloads in the same tab use a short one).

## Using it

- **Text:** type a message and press Send (or Enter). This runs LISTENING → THINKING → SPEAKING → IDLE with a canned reply.
- **Mic button:** runs a *simulated* voice exchange. No microphone is used. Press it again, or press Escape, to cancel.
- **DEV button** (top right) opens the developer panel. Ctrl+Shift+D hides or restores it completely.
  - State buttons, a full demo, energy pulse, formation, dissolve/reform and auto-rotate.
  - Sliders for eye glow, particle density, glow (bloom) strength, animation speed and speech intensity. A bloom toggle and the graphics preset.
  - **Test audio:** choose a local audio file, then Play / Pause / Stop. The mouth follows the file's real amplitude.
  - **Microphone level for listening:** asks for mic permission only when ticked. The level drives the listening animation; nothing is transcribed.

Demo speaking is synthetic, speech-like motion. It is not lip-sync.

## Assistant interface (`window.RAONE`)

```js
RAONE.setState('idle' | 'listening' | 'thinking' | 'speaking', meta?)
RAONE.getState()
RAONE.on('change', ({ from, to, meta }) => {})   // also 'idle' | 'listening' | 'thinking' | 'speaking' | 'ready' | 'dissolve'

RAONE.setSpeechAmplitude(0.5)        // drive the mouth from your TTS (0..1); null releases it
RAONE.connectAudioSource(audioEl)    // or an AudioNode / MediaStream: real amplitude → mouth
RAONE.startDemoSpeech(); RAONE.stopSpeech()
RAONE.setEyeIntensity(0.8)           // 0..1.5 override; null returns control to the state
RAONE.playEnergyPulse()
RAONE.form(); RAONE.dissolve(true | false)
```

Typical future wiring: on mic start call `setState('listening')`. When the transcript is final, call `setState('thinking')`. When TTS starts, call `setState('speaking')` and `connectAudioSource(ttsAudio)`. On end, call `setState('idle')`.
To do this, replace `InteractionSimulator` with the real pipeline; nothing in the rendering needs to change.

## How states work

`AssistantStateManager` holds exactly one active state. Each frame it eases two things toward that state's targets (about 0.75 s):
- **Weights:** one 0..1 blend per state.
- **Parameters:** eye, neural activity, glitch rate and dust activity.

The effects turn these into shader uniforms, so every transition blends rather than switches.

| State | Visual behaviour |
|---|---|
| Idle | Dim, calm eyes. Hood breathing, slow link pulses, dust drifting outward, an energy flow across the face, occasional glitch bursts. |
| Listening | Attentive eyes. Particles converge toward the face, ripples cross the hood, the face responds to the input level, waveform arcs appear below the mouth, dust is more active. |
| Thinking | Eyes brighten and pulse rhythmically with an inner flicker. Brow and eye-socket activity rises, clusters gather and separate, link pulses speed up, a slow energy wave passes through the hood, and the face flickers briefly. |
| Speaking | The mouth energy slit opens and closes with amplitude, gaining particle density. The lower face and jaw follow it, rings pulse outward from the mouth, and a scan line sweeps the slit. |

## Structure

```
backend/                         Module 1 FastAPI (health, assistant state, WebSocket)
src/
  main.js                        wiring, preset detection, adaptive quality, frame loop, visibility pause
  api/BackendClient.js           FastAPI HTTP + WebSocket client (reconnect, state sync)
  api/config.js                  VITE_BACKEND_URL / ?backend= override
  assistant/RaOneAssistant.js    public interface (window.RAONE)

  assistant/InteractionSimulator.js  cancellable mock LISTENING→THINKING→SPEAKING→IDLE sequence
  assistant/mockResponses.js     canned replies
  state/AssistantStateManager.js single active state, eased weights and params, events
  scene/SceneManager.js          renderer, bloom + vignette, pixel-ratio cap, context loss
  scene/CameraController.js      aspect-aware framing, ±20° orbit
  character/CosmicCharacter.js   owns all layers and effects; state → uniforms
  character/HoodGeometry.js      hood profile, folds, cowl, pointed-arch opening, layered hood particles
  character/FaceParticles.js     sculpted face height field, curvature-weighted particles, face mesh
  character/Contours.js          luminous structural contour lines
  character/EyeCores.js          slanted energy-core eyes
  character/HologramFigure.js    semi-transparent hologram surfaces (hood veil, face)
  materials/HolographicMaterial.js  fresnel/scanline hologram shader (after ektogamat's, MIT)
  particles/ParticleSystem.js    presets, layer assembly, energy nodes, one-buffer packing
  particles/ParticleConnections.js  neural links (spatial hash), contours, sparks
  particles/CosmicDust.js        micro dust and nebula layers
  effects/IdleEffect.js, ListeningEffect.js, ThinkingEffect.js, EyeGlowController.js
  effects/FormationAnimation.js, DissolveAnimation.js, EnergyPulse.js
  speech/VoiceAmplitudeAnalyzer.js  Web Audio RMS + attack/release; element/node/stream/mic
  speech/MouthController.js      holographic mouth (particles + lines), smoothed amplitude
  speech/SpeechVisualizer.js     mouth source: off / demo / audio / external; local test audio
  speech/DemoSpeechGenerator.js  synthetic syllable envelope
  shaders/                       particle vertex/fragment shaders, shared noise
  ui/AssistantUI.js, ConversationPanel.js, AssistantDebugPanel.js
  styles/main.css
```

## Particle layers

All point layers share one buffer and one draw call, and the shaders animate them all. JavaScript only sets uniforms each frame.

- **A, structure:** hood outer, mid and inner shells, with density following the fold crests. A rim band gives the fabric thickness around the opening. The sculpted face's density follows its curvature; parts outside the opening are dimmed, as if hidden by the hood. Plus a neck.
- **B:** micro dust.
- **C:** neural links, plus structural contour lines (opening lip, fold crests, jaw, brow, nose, cheekbones).
- **D:** energy nodes.
- **E:** nebula.
- **F:** drift clusters that peel off the edges and return.
- **G:** per-particle glitch.

## Performance

- Presets: Low ~24k, Medium ~45k, High ~100k particles. Pixel ratio is capped per preset and never exceeds the device's own.
- The start preset is Low on mobile and on integrated or software GPUs, otherwise Medium.
- If the frame rate stays under 28 fps, the app steps down a preset. On Low it switches bloom off as a last resort.
- Rendering stops while the tab is hidden, and pauses during WebGL context loss.
- Changing the preset rebuilds only the particle buffers. Formation and dissolve are uniform-driven, so nothing is recreated.
- Measured headless on this laptop (Intel UHD 620): Low about 35–40 fps, Medium about 25 fps.
