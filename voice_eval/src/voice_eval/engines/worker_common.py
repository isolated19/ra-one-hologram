"""Shared worker I/O protocol: JSON request on stdin → JSON response + WAV path."""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

import numpy as np
import soundfile as sf


def read_request() -> dict:
    return json.load(sys.stdin)


def write_response(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def fail(msg: str, **extra) -> None:
    write_response({"success": False, "error": msg, **extra})


def save_wav(path: str | Path, audio: np.ndarray, sr: int) -> str:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    peak = float(np.max(np.abs(x)) or 1.0)
    if peak > 0.95:
        x = x * (0.95 / peak)
    sf.write(str(path), x, sr)
    return str(path.resolve())


def run_worker(handler):
    try:
        req = read_request()
        out = handler(req)
        write_response(out)
    except Exception as exc:  # noqa: BLE001
        fail(f"{type(exc).__name__}: {exc}", traceback=traceback.format_exc())
        sys.exit(1)
