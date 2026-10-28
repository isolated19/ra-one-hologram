"""
Coqui YourTTS worker via maintained `coqui-tts` package (not obsolete `TTS` alone).
API: TTS(...).tts_to_file(text=..., speaker_wav=..., language="en", file_path=...)
"""

from __future__ import annotations

import os
import time
from pathlib import Path
import sys

_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(_ROOT / "src"))

import numpy as np
import soundfile as sf

from voice_eval.engines.worker_common import run_worker, save_wav
from voice_eval.metrics import audio_stats, current_rss_mb
from voice_eval.pronunciation import to_spoken_text


def handle(req: dict) -> dict:
    from TTS.api import TTS

    text = to_spoken_text(req.get("text", ""))
    out_path = req["output_path"]
    reference = req.get("reference_wav")
    model_name = req.get("model") or "tts_models/multilingual/multi-dataset/your_tts"

    if not reference or not Path(reference).exists():
        return {
            "success": False,
            "engine": "coqui_yourtts",
            "error": "YourTTS requires a valid speaker_wav reference for cloning. No generic speaker profile used.",
            "cloning_used": False,
        }

    rss0 = current_rss_mb()
    t0 = time.perf_counter()
    tts = TTS(model_name=model_name, progress_bar=False)
    # CPU-only path
    try:
        tts = tts.to("cpu")
    except Exception:
        pass
    load_sec = time.perf_counter() - t0

    tmp = str(Path(out_path).with_suffix(".raw.wav"))
    t1 = time.perf_counter()
    tts.tts_to_file(
        text=text,
        speaker_wav=reference,
        language="en",
        file_path=tmp,
    )
    synth_sec = time.perf_counter() - t1

    audio, sr = sf.read(tmp, dtype="float32")
    path = save_wav(out_path, np.asarray(audio), int(sr))
    try:
        Path(tmp).unlink(missing_ok=True)
    except Exception:
        pass
    stats = audio_stats(audio, int(sr))
    peak_rss = current_rss_mb()

    return {
        "success": True,
        "engine": "coqui_yourtts",
        "mode": "clone",
        "cloning_used": True,
        "load_sec": load_sec,
        "synthesize_sec": synth_sec,
        "peak_rss_mb": peak_rss,
        "delta_rss_mb": peak_rss - rss0,
        "sample_rate": int(sr),
        "output_path": path,
        "spoken_text": text,
        "offline_after_cache": True,
        "notes": ["your_tts_requires_speaker_wav", "package=coqui-tts"],
        **stats,
    }


if __name__ == "__main__":
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
    run_worker(handle)
