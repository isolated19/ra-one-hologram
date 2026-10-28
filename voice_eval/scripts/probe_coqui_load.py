"""Load-only probe for Coqui YourTTS (no synthesis without owned reference)."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

from voice_eval.metrics import current_rss_mb  # noqa: E402


def main() -> int:
    rss0 = current_rss_mb()
    t0 = time.perf_counter()
    from TTS.api import TTS

    import_sec = time.perf_counter() - t0
    t1 = time.perf_counter()
    tts = TTS(model_name="tts_models/multilingual/multi-dataset/your_tts", progress_bar=False)
    try:
        tts.to("cpu")
    except Exception:
        pass
    load_sec = time.perf_counter() - t1
    out = {
        "success": True,
        "engine": "coqui_yourtts",
        "mode": "load_only",
        "import_sec": round(import_sec, 2),
        "load_sec": round(load_sec, 2),
        "peak_rss_mb": round(current_rss_mb(), 1),
        "delta_rss_mb": round(current_rss_mb() - rss0, 1),
        "cloning_used": False,
        "notes": ["load_only_no_reference_wav", "package=coqui-tts"],
    }
    print(json.dumps(out, indent=2))
    (ROOT / "results" / "coqui_load_probe.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
