# RA-ONE Voice Cloning Evaluation — Recommendation

**Hardware:** Windows 11 · Python 3.12 · Intel i7-8650U · 16 GB RAM · CPU-only  

**Automatic metrics winner (feasible runs):** `pocket_tts`  

**Replace production Piper now?** `False` — cloning was not validated with your owned `my_voice.wav`, and subjective rugged/cinematic quality still needs listening.

## Measured results

| Engine | Mode | Load s | Synth s | Peak RSS MB | Clone | Notes |
|--------|------|--------|---------|-------------|-------|-------|
| **Pocket TTS** (`pocket-tts` 4.0.1) | builtin `alba` | 7.1 | **2.5** | ~489 | No* | Fastest synth on this laptop |
| **Kokoro ONNX** | voice `am_adam` | **2.1** | 6.0 | ~349 | N/A | Lightest RAM; installed voices only |
| **Coqui YourTTS** (`coqui-tts` 0.28) | load_only | **51.2** | — | ~688 | Blocked | Needs `speaker_wav`; heaviest install |

\* Pocket clone mode is implemented (`get_state_for_audio_prompt`) but **skipped** — `reference/my_voice.wav` was missing.

### Outputs to listen

- `results/pocket_20261022_182731_commander.wav`
- `results/kokoro_20261022_182722_commander.wav`

UI displays **RA-ONE**; spoken text was **Raw-One**.

## Comparison (this machine)

| Criterion | Pocket TTS | Coqui YourTTS | Kokoro ONNX |
|-----------|------------|---------------|-------------|
| Voice similarity (clone) | Pending your WAV | Pending your WAV | No WAV cloning |
| Rugged cinematic potential | High (clone + FX) | High if clone works | Medium (pick deep male voice + FX) |
| Naturalness | Listen (builtin sample) | Untested synth | Listen (`am_adam`) |
| CPU speed | **Best synth** | Slow load; synth TBD | Good, mid synth |
| RAM | Medium (~490 MB) | High (~690 MB load) | **Best** (~350 MB) |
| Install complexity | Medium | **Hard** (torch + torchaudio + torchcodec) | **Easy** |
| Offline after cache | Yes | Yes (after model download) | Yes |

## Recommendation

1. **Primary candidate for cloned cinematic RA-ONE voice:** **Pocket TTS** — documented cloning API, fastest measured synthesis, acceptable RAM on 16 GB, simpler than Coqui on this CPU laptop.
2. **Baseline / fallback without a reference recording:** **Kokoro ONNX** with a deep male voice (`am_adam`, `am_fenrir`, `bm_george`) + Commander/Dark presets — lowest RAM, easy offline.
3. **Coqui YourTTS:** Keep as secondary cloning option after you add `my_voice.wav`, but expect heavier RAM and slower cold starts on the i7-8650U. Use package `coqui-tts[codec]`, not the obsolete `TTS`-only wheel.

### Next step (required before replacing Piper)

1. Place an owned 5–30 s clean recording at `voice_eval/reference/my_voice.wav`.
2. Open http://127.0.0.1:8765 → generate Pocket (clone) + Coqui + Kokoro Commander presets.
3. A/B listen for similarity, ruggedness, and “Raw-One” pronunciation.
4. Only then integrate the winner into production — Piper stays until that pass.

## Subjective scores (fill after listening)

- Voice similarity: _/10  
- Rugged quality: _/10  
- Naturalness: _/10  
