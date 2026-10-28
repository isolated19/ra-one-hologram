# RA-ONE Offline Voice Cloning Evaluation

Isolated lab for comparing **Pocket TTS**, **coqui-tts YourTTS**, and **Kokoro ONNX** on this Windows laptop.  
**Does not modify or replace** the production Piper TTS in `backend/app/voice/`.

## Quick start

```powershell
cd voice_eval
.\setup_venvs.ps1
# Place owned reference:
#   reference\my_voice.wav

# Benchmarks (writes results\benchmark_report.json + RECOMMENDATION.md)
.\venvs\base\Scripts\python.exe scripts\run_benchmarks.py

# Comparison UI — http://127.0.0.1:8765
$env:PYTHONPATH="src"
.\venvs\base\Scripts\python.exe -m voice_eval.server
```

## Engines

| Engine | Package | Cloning |
|--------|---------|---------|
| Pocket TTS | `pocket-tts` | Yes (`get_state_for_audio_prompt`) |
| YourTTS | `coqui-tts` (not obsolete `TTS`) | Yes (`speaker_wav`) |
| Kokoro ONNX | `kokoro-onnx` | No — installed voices only |

UI always labels the assistant **RA-ONE**; synthesis text uses **Raw-One**.
