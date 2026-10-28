# RA-ONE Desktop Build Plan (browser → Windows startup app)

Goal: a single installed `RA-ONE.exe` that starts at Windows login, runs the
FastAPI backend in the background, shows the hologram in its own window (no
browser), and listens for clap / "Hey RA-ONE" fully offline.

Build and test **one module at a time**. Do not start a module until the
previous one's "Done when" checks pass.

```
┌──────────────── RA-ONE.exe (Electron) ────────────────┐
│ main process                                           │
│  • single-instance lock, tray icon, login-item         │
│  • spawns backend.exe, waits for /api/health           │
│  • grants mic permission                               │
│                                                        │
│ renderer (existing Vite/Three.js app, unchanged UI)    │
│  • getUserMedia → AudioWorklet → 16 kHz PCM            │──┐
│  • clap detection (local)                              │  │ ws://127.0.0.1:8000/ws/stt
└────────────────────────────────────────────────────────┘  │
┌──────────────── backend.exe (PyInstaller) ─────────────┐  │
│ FastAPI: /ws/stt (Vosk wake + faster-whisper question) │◄─┘
│          /api/conversation (Ollama) · /api/voice (Piper)│
│          serves built frontend (dist/) at /             │
└────────────────────────────────────────────────────────┘
          Ollama (separate install, its own autostart)
```

---

## Why the current audio path cannot ship as a desktop app

| Today (browser) | Problem in Electron / offline |
|---|---|
| `WakeWordDetector` + `SpeechRecognitionService` use `webkitSpeechRecognition` | Chrome sends audio to Google. In Electron there is no Google API key, so it always fails with `network`. **Speech-to-text must move to the backend.** |
| `ClapDetector._tick` runs on `requestAnimationFrame` and returns when `document.hidden` | rAF stops in a hidden/minimized window, so clap wake dies when the app is in the tray. |
| `AudioSessionManager._bindVisibility` suspends the `AudioContext` when hidden | Same problem: the mic graph goes silent in the background. |
| `VoiceConfig.MODELS_DIR` uses `Path(__file__).parents[2]` | Wrong inside a PyInstaller bundle; needs an env/exe-relative path. |
| CORS allows only `localhost:5173` | Packaged app would have a different origin. Serve `dist/` from FastAPI to make it same-origin. |

---

## Module 0 — Baseline: browser path works end to end

**Already fixed:** `VoiceInteractionController._onActivation` referenced an
undefined `sessionGen` after the spoken wake acknowledgement. That threw a
`ReferenceError`, so `stt.startQuestionCapture()` never ran: RA-ONE woke,
said "listening", and then never captured your voice. Regression test:
`tests/lifecycleWake.test.js` → `TC-08b`.

**Test**
1. `cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000`
2. `npm run dev`, then open in **Chrome or Edge** (not Firefox).
3. Enable hands-free, clap, wait for the spoken ack, ask a question.
4. If you see `STT network`, Chrome cannot reach Google's speech service
   (VPN, firewall or offline). This is the limitation that Module 1 removes.

**Done when:** clap → ack → your question shows in the transcript → spoken
answer. `npm test` and `pytest` are green.

---

## Module 1 — Offline STT service in the backend ✅ DONE

**Built**
| File | Role |
|---|---|
| `backend/app/core/paths.py` | `MODELS_ROOT`, overridable with `RAONE_MODELS_DIR` (Piper now uses it too) |
| `backend/app/stt/STTConfig.py` | Sample rate, frame size, timeouts, model paths |
| `backend/app/stt/OfflineSTTEngine.py` | Shared Vosk + faster-whisper (`base.en`, int8), lazy load, background preload |
| `backend/app/stt/STTSession.py` | Per-connection state machine: `off` / `wake` / `question` |
| `backend/app/api/stt.py` | `GET /api/stt/status`, `POST /api/stt/transcribe` (WAV body), `WS /ws/stt` |
| `backend/scripts/download_stt_models.py` | Fetches Vosk small-en (~40 MB) + whisper base.en (~145 MB) |
| `backend/tests/test_stt.py` | 23 tests: unit (fake engine) + real models fed Piper-generated speech |

**How wake works:** Vosk runs a tiny grammar of the `WAKE_DICTIONARY`
aliases, and anything else becomes `[unk]`. That makes it cheap and resistant
to false wakes. A clean, confident "Hey RA-ONE" wakes immediately. If more
words follow ("Hey RA-ONE, what time is it"), whisper transcribes the
utterance and `match_wake_phrase` extracts the remainder. The session closes
each utterance after 500 ms of VAD silence, because Vosk's own endpointing
lags in grammar mode.

**`/ws/stt` protocol (Module 2 builds against this)**
- Client → server: binary 16 kHz mono PCM16 (any chunk size; 20 ms recommended).
- Client → server text: `{"cmd":"mode","value":"wake"|"question"|"off"}`
  (question accepts optional `grace_ms`, `silence_ms`, `max_ms`), `{"cmd":"ping"}`.
- Server → client: `ready`, `mode`, `partial {mode,text}`,
  `wake {transcript,remainder,greeting,confidence,verified_by}`, `wake_rejected`,
  `speech_start`, `final {text,reason,latency_ms,audio_sec}`, `empty {reason}`,
  `error {error,message}`, `pong`.
- After `wake`, `final` or `empty`, the server switches itself to `off`. The client
  must explicitly send the next mode. This keeps RA-ONE's own voice out of STT.

**Measured on this laptop:** whisper takes ~1.6 s per utterance (base.en int8,
4 threads). For faster but less accurate results, set `RAONE_WHISPER_MODEL=tiny.en`
and rerun the download script.

**Setup on a new machine**
```powershell
cd backend
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python scripts\download_stt_models.py
.\.venv\Scripts\python -m pytest tests\test_stt.py -v
```

---

## Module 2 — Frontend streams mic audio to the backend ✅ DONE (automated E2E re-tested; real-mic test pending)

**Built**
| File | Role |
|---|---|
| `src/audio/pcm-worklet.js` | AudioWorklet: mic → 16 kHz mono PCM16, 20 ms frames (runs on the audio thread) |
| `src/audio/ServerSttClient.js` | Owns `/ws/stt`, reconnects with backoff, replays the active mode, drops stale events by `seq` |
| `src/audio/WakeWordDetector.js` | `serverClient` option → server provider (browser path unchanged) |
| `src/audio/SpeechRecognitionService.js` | `serverClient` option → server provider (browser path unchanged) |
| `src/assistant/VoiceInteractionController.js` | Creates the shared client; attaches it in `enableHandsFree` and after mic recovery; clear messages for backend down / models missing |
| `src/api/config.js` | `STT_PROVIDER` (default `server`), `WS_STT_URL` |
| `tests/serverStt.test.js`, `tests/pcmWorklet.test.js` | 16 tests: adapters, seq filtering, disconnects, full clap→answer turn, 48 kHz→16 kHz framing |

The provider defaults to **server** (offline). Use `?stt=browser` or
`VITE_STT_PROVIDER=browser` to go back to Chrome Web Speech.

**Backend changes made during this module**
- `seq` on every mode request is echoed on events, so a late `final` from a
  cancelled question can't leak into the next turn.
- Wake + question in one breath: when more speech follows the wake words,
  the session records until 900 ms of silence before running whisper. Vosk's
  grammar endpointing fired mid-sentence and cut "what is 2 plus 2" to "what is 2 plus-".
- TTS warm-up at startup: librosa's first `time_stretch` took 3–20 s, which
  delayed the first spoken reply. It now runs in a background thread before the STT preload.
- The Vosk grammar no longer includes single-token aliases ("raone"), which
  the small model can't produce and which logged warnings for every session.
- The backend logs every `STT wake`, `STT final` and `STT wake rejected` line at INFO.

**Verified end to end in real Chrome (fake mic = Piper WAV)**
`Hey RA-ONE, what is two plus two?` → worklet → `/ws/stt` → `STT wake (whisper)`
with remainder `what is 2 plus 2` → LLM `RA-ONE: 4.` → Piper speech → standby
follow-up window. The clap detector was disabled for that run because Piper's
sharp onset from digital silence also triggers it.

**Re-tested 2026-10-23 (fake mic, clap detector ON) — two bugs found and fixed**
- *False clap on speech:* the old detector judged one ~10 ms frame, so a loud
  syllable of "Hey RA-ONE, what is two…" passed as a clap. The spoken ack then
  talked over the question and only "Plus 2." was captured. Fixed in Module 3
  (decay + zero-crossing checks).
- *Piper TTS 500 on emoji / em dash replies:* `/api/voice/synthesize` put the
  raw reply into the `X-RAONE-Spoken-Text` header, which must be latin-1. It is
  now percent-encoded (`test_synthesize_non_latin1_reply`).
- After the fixes: "Hey RA-ONE, what is two plus two?" → `STT wake (whisper)`
  remainder `what is 2 plus 2` → answer → Piper → standby, with no false clap.
  Clap → ack → "What is the capital of France?" → answer → standby. Both pass.

**Manual test (your microphone)**
1. Backend: `cd backend; .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000`
2. Wait for `Whisper base.en loaded` in the log, then run `npm run dev` and open `http://localhost:5173`.
3. Click once to allow the mic. Then try:
   - "Hey RA-ONE" (pause) → spoken ack → ask a question
   - "Hey RA-ONE, what time is it?" in one breath
   - normal talking without the name → must **not** wake
4. Repeat with Wi-Fi **off**. Everything except first-time model downloads must still work.
5. The backend console shows what was heard (`STT wake …`, `STT final …`).

**Known performance notes (not blockers)**
- Whisper base.en takes ~1.6 s per sentence on an idle CPU. Under heavy load
  (the headless test rendering WebGL in software) it was ~5 s. If it feels slow,
  try `RAONE_WHISPER_MODEL=tiny.en`.
- Each conversation turn makes **two** Ollama calls (intent + answer), so a turn
  took 9–11 s here. Speeding that up belongs to the LLM module, not STT.

---

## Module 3 — Background-safe audio ✅ DONE (real-mic clap test pending)

**Built**
| File | Role |
|---|---|
| `src/audio/level-worklet.js` | AudioWorklet: 10 ms frames of mean \|x\|, peak, zero-crossing rate (audio thread, unthrottled when hidden) |
| `src/audio/ClapDetector.js` | Fed by the worklet instead of `requestAnimationFrame`; no `document.hidden` early return |
| `src/audio/AudioSessionManager.js` | No longer suspends the `AudioContext` when hidden (browser **and** desktop); only resumes it on show if the browser suspended it |
| `src/main.js` | Render loop still pauses while hidden. Hands-free now starts immediately if the page loads hidden (tray start), instead of waiting for the formation's `ready`, which never fires while rendering is paused |
| `tests/clapDetector.test.js` | 9 tests: clap accepted, speech onset rejected, voiced syllable rejected, cooldown, disarm, worklet wiring |

**Clap vs. speech.** A candidate onset (same peak/rise/noise gates as before)
must also:
- be broadband: zero-crossing rate ≥ 0.10 (voiced syllables ~0.05; 0.04 at sensitivity ≥ 0.85);
- stay above half its max energy for ≤ 40 ms, and fall below 30 % of it by 150 ms.

Offline sweep (3 Piper voices × 11 phrases × 3 gains = 99 utterances): false
claps went from 36/99 (decay check alone) to 2/99 (both remaining are hard
plosives: "**P**ut…", "**Ch**eck…"). All dry/room/reverberant synthetic claps are
still detected. A clap is reported ~150 ms after it happens.

**Verified (headless Chrome, tab really backgrounded)**
- Hidden after enable: clap → ack → question → answer → standby. `AudioContext` stays `running`.
- Loaded hidden: hands-free starts and the same flow works.
- Hidden idle CPU (8 logical cores): Chrome 2.1 % + backend 2.2 % = **4.3 %**.

**Still to check with your mic:** real claps at a normal distance, and that
normal talking near the mic does not wake RA-ONE by clap (watch the
**Clap:** debug pill: `zcr_voice_like` / `sustained` = correctly rejected).

---

## Module 4 — Backend as a standalone exe ✅ DONE

**Built**
| File | Role |
|---|---|
| `backend/run_server.py` | Desktop entry / PyInstaller target. Binds **127.0.0.1** (`RAONE_HOST`), `PORT` (8000), file logging, `log_config=None` so uvicorn logs go to the same file |
| `backend/raone-backend.spec` | PyInstaller onedir, `console=False`. Collects onnxruntime, ctranslate2, vosk, faster_whisper, libsndfile, librosa, Piper's espeak-ng data; excludes Piper's torch/flask extras |
| `backend/pyinstaller_hooks/hook-webrtcvad.py` | Overrides the contrib hook (we install `webrtcvad-wheels`, not `webrtcvad`) |
| `backend/scripts/build_backend.ps1` | `pip install -r requirements-build.txt` + PyInstaller → `backend\dist\raone-backend\` (560 MB, models excluded) |
| `app/core/paths.py` | Frozen-aware: `BACKEND_ROOT` = exe folder; `STATIC_DIR` (`RAONE_STATIC_DIR`); `LOG_DIR` (`RAONE_LOG_DIR`, default `%LOCALAPPDATA%\RAONE\logs`, same root as `permissions.json`) |
| `app/core/logging.py` | Optional rotating `backend.log` (2 MB × 3); no console handler when there is no stdout. Crash tracebacks → `stderr.log` |
| `app/main.py` | Serves `RAONE_STATIC_DIR` at `/` after all API/WS routes (same origin, no CORS) |
| `src/api/config.js`, `vite.config.js` | Production builds call their own origin; `vite preview` proxies `/api` + `/ws` to :8000 |
| `tests/test_desktop_server.py` | UI + API + WS from one app, API-only mode, frozen paths, file logging with no stdout |

**Startup rework (affects dev too).** Model loading used to block the server
for ~23 s (three Piper voices, 5–10 s each) before STT even began. Now the
server listens at once and a background thread loads, in order of need:
STT (wake) → default voice + TTS warm-up → other voices.

**numba cache.** librosa's TTS effects compile with numba on first use: 25 s
in the exe, and recompiled on every boot because numba only caches functions
whose `.py` source exists. The spec ships librosa as `pyz+py`, so later boots
reuse the cache in `_internal\librosa\__pycache__`. If the install folder is
read-only, numba falls back to its per-user cache (read from numba's source,
not tested).

**Verified** (exe copied to a folder outside the repo, `RAONE_STATIC_DIR=dist`,
`RAONE_MODELS_DIR=backend\models`)
| | First boot | Later boots |
|---|---|---|
| `/api/health` | ~3 s | ~3 s |
| Wake / STT ready | 2.6 s | 2.6 s |
| TTS warm-up | 25 s | 3.4 s |
| All voices loaded | 42 s | 20 s |

(Timings with model files already in the Windows file cache; a cold disk after
reboot will be slower — re-measure in Module 6.)
- `http://127.0.0.1:8000/` serves the UI; listening on `127.0.0.1` only.
- "Hey RA-ONE, what is two plus two?" → wake + remainder → answer → Piper → standby.
- Clap → question → answer with the tab hidden.
- Logs written to `RAONE_LOG_DIR\backend.log`; Piper version reported (`1.8.0`).

**Build / run**
```powershell
npm run build                                            # → dist\
powershell -ExecutionPolicy Bypass -File backend\scripts\build_backend.ps1
$env:RAONE_STATIC_DIR="$PWD\dist"; $env:RAONE_MODELS_DIR="$PWD\backend\models"
.\backend\dist\raone-backend\raone-backend.exe           # no window; open http://127.0.0.1:8000/
```
Stop it from Task Manager (`raone-backend.exe`) until Module 5 adds the tray.

---

## Module 5 — Electron shell ✅ DONE

**Run**
```powershell
npm run desktop          # builds the UI; the backend serves it (same as production)
npm run desktop:dev      # hot reload: run `npm run dev` first. Cold first load ≈ 1 min (Vite compiles every module)
node desktop\launch.cjs --hidden   # start in the tray
node desktop\launch.cjs --quit     # stop a running instance (for the installer / scripts)
```

**Built**
| File | Role |
|---|---|
| `desktop/main.cjs` | Single-instance lock, tray, window, backend lifecycle, mic permission, navigation lock |
| `desktop/preload.cjs` | `window.raoneDesktop = { isDesktop, platform, isVisible(), onVisibilityChange() }` |
| `desktop/launch.cjs` | Used by the npm scripts; clears `ELECTRON_RUN_AS_NODE` (VS Code sets it, which turns `electron.exe` into plain Node) |
| `desktop/icon.ico`, `desktop/icon-256.png` | From `raone_logo_icon_favicon_pack` (window/taskbar icon; tray icon is a runtime crop, see below) |
| `src/utils/pageVisibility.js` | Visibility that works in both the browser and the shell |
| `backend/run_server.py` | `RAONE_PARENT_PID`: backend exits when the shell dies (crash / Task Manager) |

**Behaviour**
- A "Starting…" page shows at once; the app loads when `/api/health` answers. If the
  backend fails, the window shows the error and the log folder.
- If a backend already answers on :8000 it is reused (and left running on quit).
- Close (X) hides to the tray; tray click toggles; menu: Show / Hide / Quit.
- Second launch focuses the window; `--quit` as a second launch stops the running one.
- Mic is granted without a prompt, but only to RA-ONE's own origin. Other URLs open in
  the default browser; in-window navigation away from RA-ONE is blocked.
- `autoplay-policy=no-user-gesture-required`, so hands-free and TTS work from a tray start.

**Electron gotcha fixed.** `backgroundThrottling: false` (needed so timers and the
mic keep running in the tray) makes Chromium report the page as **visible** even
when the window was never shown. Without a fix the render loop would keep drawing in
the tray, and a `--hidden` start waited ~70 s for the intro before turning the mic on.
The shell now reports real window visibility through the preload; `main.js` pauses
rendering on it, and the desktop app starts hands-free immediately.

**Tray icon.** The pack's icons are mostly padding (figure ≈ 46 % of the canvas, a
5×4 px blob at 16 px). The shell crops `icon-256.png` to the hood and builds
16/24/32 px tray images at runtime, so the source files are not modified.

**Verified** (real Electron 45 app, fake mic, driven over CDP)
| Check | Result |
|---|---|
| Window start → "Hey RA-ONE, what is two plus two?" | wake + remainder → answer → speech → standby |
| `--hidden` start → clap → "What is the capital of France?" | mic on 7 s after launch; full turn while hidden |
| Idle CPU in the tray / with window visible | Electron 1.9 % + backend 1.2 % / Electron 17.7 % |
| Second launch | exits rc 0, window becomes visible, same backend |
| `--quit` | Electron and backend both gone, port 8000 free |
| Electron force-killed (simulated crash) | backend exits 0.5 s later |
| `--vite` mode | loads from :5173, mic on, quits cleanly |

**Still to check by hand:** the tray icon's look on your taskbar, and the window
with your real microphone. If the mic is silent: Windows **Settings → Privacy →
Microphone → "Let desktop apps access your microphone"** must be on.

---

## Module 6 — Start at login ✅ DONE (reboot smoke test pending)

**Built**
| File | Role |
|---|---|
| `desktop/main.cjs` | Packaged builds: `setLoginItemSettings({ openAtLogin, args: ['--hidden'] })`. Preference in `%APPDATA%/<userData>/login-pref.json` so a tray disable survives restarts. Tray checkbox **Start with Windows** (disabled in unpackaged/dev). |
| `backend/app/llm/ollama_wait.py` | Poll Ollama health every 5 s for up to 60 s after boot (Windows login lag). |
| `backend/app/main.py` | Background `asyncio` task runs the wait; does not block `/api/health`. |
| `backend/tests/test_ollama_wait.py` | Immediate success / poll-until-up / timeout. |
| `tests/desktopLogin.test.js` | Pref default + persist disable/enable. |

**Behaviour**
- First packaged run enables login item (starts with `--hidden` → tray).
- Later runs respect the saved preference.
- Dev (`npm run desktop` / `--vite`) does **not** register a login item.
- Backend logs when Ollama becomes reachable after boot; conversation already re-checks health per turn.

**Still to check by hand:** reboot with a packaged install, clap within 60 s of the
desktop appearing, confirm wake + answer. Pull `qwen3:1.7b` when the network is stable
(`ollama pull qwen3:1.7b`) — only `0.6b` may be present.

---


## Module 7 — Installer ✅ SCAFFOLDED (full NSIS artifact not produced in this pass)

**Built**
| File | Role |
|---|---|
| `package.json` → `build` | `appId` `com.raone.assistant`, NSIS x64, `extraResources` = backend exe + models + `dist` web UI |
| `scripts/build-desktop.ps1` | tests → `npm run build` → PyInstaller → `electron-builder --win` |
| `npm run desktop:dist` | Runs the PowerShell build script |

**Produce an installer on this machine**
```powershell
npm install                                          # pulls electron-builder
# Ensure backend\models has STT + Piper voices (download scripts)
npm run desktop:dist                                 # → release\*.exe
```

**Still to verify on a clean account / VM:** install → reboot → autostart + clap
wake → uninstall clears the login item. Do not mark Module 8 complete until that
smoke pass succeeds.

---


## Module 8 — Acceptance checklist

Run after a Module 7 installer smoke (or `npm run desktop` for items that do not need install).

- [ ] Works with Wi-Fi off (except the initial Ollama model pull)
- [ ] Cold boot to "listening" in under 20 s
- [ ] Idle CPU under 5 % with the window hidden; RAM under 1.5 GB excluding Ollama
- [ ] Clap and "Hey RA-ONE" both wake from tray
- [ ] No false wake from RA-ONE's own speech (detectors stay disarmed during TTS)
- [ ] Mic unplugged/replugged recovers (`AudioSessionManager` `interrupted` path)
- [ ] Backend crash → Electron restarts it (add `backend.on('exit')` respawn, max 3) — **not yet coded; tracked for Module 8 close-out**
- [ ] Logs in `%LOCALAPPDATA%\RAONE\logs` (`backend.log`, `stderr.log`)
- [ ] Packaged: "Start with Windows" tray toggle persists across reboot
- [ ] Packaged: uninstall removes the login item (or user can clear it)

**Phase 2 Module 9+ must not start until this checklist is signed off.**
