# RA-ONE Phase 2 — Implementation Progress

Gate rule (from the master Phase 2 spec): **Modules 9+ start only after the
desktop build (DESKTOP_BUILD_PLAN Modules 0–8) is completed and verified.**

## Desktop build gate (`docs/DESKTOP_BUILD_PLAN.md`)

| Module | Status |
|--------|--------|
| 0 Baseline browser E2E | Done |
| 1 Offline STT (Vosk + Whisper) | Done |
| 2 Frontend → `/ws/stt` | Done (real-mic optional) |
| 3 Background-safe audio | Done (real-mic clap optional) |
| 4 Backend PyInstaller exe | Done |
| 5 Electron shell | Done |
| 6 Start at login + Ollama boot wait | **Done 2026-10-23** (reboot smoke pending) |
| 7 Installer (electron-builder) | **Scaffolded 2026-10-23** — run `npm run desktop:dist` for NSIS; clean-account smoke pending |
| 8 Acceptance checklist | Open — requires packaged install smoke |

## Phase 2 agent modules (9–24)

| Module | Status |
|--------|--------|
| 9 Owner Identity and Personal Knowledge | **Blocked** on desktop Modules 7–8 |
| 10–24 | Not started |

## Notes

- Do not invent owner facts; ask when the profile is incomplete.
- Local-first: profile under `%APPDATA%\RA-ONE\knowledge\`.
- Preserve existing tests when adding modules.

## Latency fix (2026-10-23)

**Cause:** Simple “hi” ran **two** Ollama calls (intent classify + answer) → ~6–11 s.

**Fix:** `FastReplyService` (zero LLM for greetings/time/identity) + intent rules
short-circuit at confidence ≥ 0.7 (skip classify LLM for clear questions).

| Utterance | Before (approx) | After (measured) |
|-----------|-----------------|------------------|
| `hi` | 6–11 s (llm×2) | **~100 ms** (`source=fast`) |
| `What is Python?` | 9–11 s (llm×2) | **~2 s** (one llm) |

Installed `RA-ONE Setup` must be rebuilt (`npm run desktop:dist`) to pick this up.
