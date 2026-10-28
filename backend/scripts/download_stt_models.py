#!/usr/bin/env python3
"""Download offline STT models (Vosk wake gate + faster-whisper) — install-time only."""

from __future__ import annotations

import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.stt.STTConfig import (  # noqa: E402
    VOSK_MODEL_DIR,
    VOSK_MODEL_URL,
    WHISPER_MODEL_DIR,
    WHISPER_MODEL_SIZE,
)


def download_vosk() -> bool:
    if (VOSK_MODEL_DIR / "am").exists():
        print(f"[skip] Vosk model already present: {VOSK_MODEL_DIR}")
        return True
    VOSK_MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
    print(f"[download] {VOSK_MODEL_URL}")
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / "vosk.zip"
        urllib.request.urlretrieve(VOSK_MODEL_URL, archive)
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(tmp)
        extracted = Path(tmp) / VOSK_MODEL_DIR.name
        if not extracted.exists():
            print("[error] unexpected archive layout")
            return False
        shutil.move(str(extracted), str(VOSK_MODEL_DIR))
    print(f"[ok] Vosk -> {VOSK_MODEL_DIR}")
    return True


def download_whisper() -> bool:
    if (WHISPER_MODEL_DIR / "model.bin").exists():
        print(f"[skip] Whisper model already present: {WHISPER_MODEL_DIR}")
        return True
    try:
        from faster_whisper import download_model
    except Exception as exc:
        print("faster-whisper is not installed:", exc)
        return False
    WHISPER_MODEL_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[download] faster-whisper {WHISPER_MODEL_SIZE}")
    download_model(WHISPER_MODEL_SIZE, output_dir=str(WHISPER_MODEL_DIR))
    print(f"[ok] Whisper -> {WHISPER_MODEL_DIR}")
    return True


def main() -> int:
    ok = download_vosk()
    ok = download_whisper() and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
