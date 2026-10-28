"""
Kokoro ONNX baseline — installed voices only (no arbitrary WAV cloning).
API: Kokoro(model, voices).create(text, voice=..., speed=..., lang=...)
"""

from __future__ import annotations

import os
import time
import urllib.request
from pathlib import Path
import sys

_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_ROOT / "src"))

from voice_eval.engines.worker_common import run_worker, save_wav
from voice_eval.metrics import audio_stats, current_rss_mb
from voice_eval.pronunciation import to_spoken_text

MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"


def _ensure_models(cache: Path) -> tuple[Path, Path]:
    cache.mkdir(parents=True, exist_ok=True)
    model = cache / "kokoro-v1.0.onnx"
    voices = cache / "voices-v1.0.bin"
    # Prefer int8 for laptop RAM/CPU if present
    int8 = cache / "kokoro-v1.0.int8.onnx"
    if not model.exists() and not int8.exists():
        print(f"Downloading Kokoro model to {model}…", file=sys.stderr)
        urllib.request.urlretrieve(MODEL_URL, model)
    if not voices.exists():
        print(f"Downloading Kokoro voices to {voices}…", file=sys.stderr)
        urllib.request.urlretrieve(VOICES_URL, voices)
    use = int8 if int8.exists() else model
    return use, voices


def handle(req: dict) -> dict:
    from kokoro_onnx import Kokoro

    text = to_spoken_text(req.get("text", ""))
    out_path = req["output_path"]
    cache = Path(req.get("cache_dir") or (_ROOT / "cache" / "kokoro"))
    preferred = req.get("voice") or "am_adam"
    notes = ["no_wav_cloning_installed_voices_only"]

    rss0 = current_rss_mb()
    t0 = time.perf_counter()
    model_path, voices_path = _ensure_models(cache)
    kokoro = Kokoro(str(model_path), str(voices_path))
    load_sec = time.perf_counter() - t0

    available = list(kokoro.get_voices())
    voice = preferred if preferred in available else next(
        (v for v in ("am_adam", "am_michael", "bm_george", "am_fenrir") if v in available),
        available[0] if available else preferred,
    )
    if voice != preferred:
        notes.append(f"voice_fallback={preferred}->{voice}")

    t1 = time.perf_counter()
    samples, sr = kokoro.create(text, voice=voice, speed=0.95, lang="en-us")
    synth_sec = time.perf_counter() - t1
    path = save_wav(out_path, samples, int(sr))
    stats = audio_stats(samples, int(sr))
    peak_rss = current_rss_mb()

    return {
        "success": True,
        "engine": "kokoro_onnx",
        "mode": "installed_voice",
        "cloning_used": False,
        "voice": voice,
        "available_voices": available[:20],
        "load_sec": load_sec,
        "synthesize_sec": synth_sec,
        "peak_rss_mb": peak_rss,
        "delta_rss_mb": peak_rss - rss0,
        "sample_rate": int(sr),
        "output_path": path,
        "spoken_text": text,
        "offline_after_cache": model_path.exists() and voices_path.exists(),
        "notes": notes,
        **stats,
    }


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    run_worker(handle)
