"""
Pocket TTS worker (Kyutai). Documented API:
  TTSModel.load_model() / get_state_for_audio_prompt() / generate_audio()
https://kyutai-labs.github.io/pocket-tts/API%20Reference/python-api/
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import numpy as np

# Ensure package root on path when run as script
_ROOT = Path(__file__).resolve().parents[3]
import sys

sys.path.insert(0, str(_ROOT / "src"))

from voice_eval.engines.worker_common import run_worker, save_wav  # noqa: E402
from voice_eval.metrics import audio_stats, current_rss_mb  # noqa: E402
from voice_eval.pronunciation import to_spoken_text  # noqa: E402


def handle(req: dict) -> dict:
    from pocket_tts import TTSModel

    text = to_spoken_text(req.get("text", ""))
    out_path = req["output_path"]
    language = req.get("language") or "english_7m_2026-10"
    reference = req.get("reference_wav")
    builtin = req.get("builtin_voice") or "alba"
    mode = req.get("mode", "clone" if reference else "builtin")

    rss0 = current_rss_mb()
    t0 = time.perf_counter()
    # Prefer smaller English model on i7-8650U; fall back to default
    try:
        model = TTSModel.load_model(language=language)
    except Exception:
        model = TTSModel.load_model()
    load_sec = time.perf_counter() - t0
    rss_after_load = current_rss_mb()

    notes = []
    cloning = False
    if mode == "clone" and reference and Path(reference).exists():
        t1 = time.perf_counter()
        voice_state = model.get_state_for_audio_prompt(reference)
        clone_sec = time.perf_counter() - t1
        notes.append(f"voice_state_extract_sec={clone_sec:.2f}")
        cloning = True
    else:
        t1 = time.perf_counter()
        voice_state = model.get_state_for_audio_prompt(builtin)
        notes.append(f"builtin_voice={builtin} extract_sec={time.perf_counter() - t1:.2f}")
        if mode == "clone":
            notes.append("clone_requested_but_reference_missing_or_invalid")

    t2 = time.perf_counter()
    audio = model.generate_audio(voice_state, text)
    synth_sec = time.perf_counter() - t2
    arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
    sr = int(model.sample_rate)
    path = save_wav(out_path, arr, sr)
    stats = audio_stats(arr, sr)
    peak_rss = max(rss_after_load, current_rss_mb())

    return {
        "success": True,
        "engine": "pocket_tts",
        "mode": "clone" if cloning else "builtin",
        "cloning_used": cloning,
        "load_sec": load_sec,
        "synthesize_sec": synth_sec,
        "peak_rss_mb": peak_rss,
        "delta_rss_mb": peak_rss - rss0,
        "sample_rate": sr,
        "output_path": path,
        "spoken_text": text,
        "offline_after_cache": True,
        "notes": notes,
        **stats,
    }


if __name__ == "__main__":
    # Reduce thread oversubscription on laptop CPUs
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    run_worker(handle)
