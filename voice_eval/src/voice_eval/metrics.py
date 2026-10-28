"""Timing / RAM helpers for engine benchmarks."""

from __future__ import annotations

import os
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field

import numpy as np

try:
    import psutil
except ImportError:  # pragma: no cover
    psutil = None  # type: ignore


@dataclass
class RunMetrics:
    engine: str
    mode: str
    success: bool
    error: str = ""
    load_sec: float = 0.0
    synthesize_sec: float = 0.0
    peak_rss_mb: float = 0.0
    delta_rss_mb: float = 0.0
    sample_rate: int = 0
    duration_sec: float = 0.0
    peak_audio: float = 0.0
    rms_audio: float = 0.0
    offline_after_cache: bool = False
    cloning_used: bool = False
    output_path: str = ""
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def current_rss_mb() -> float:
    if psutil is None:
        return 0.0
    return psutil.Process(os.getpid()).memory_info().rss / (1024 * 1024)


@contextmanager
def track_rss():
    start = current_rss_mb()
    peak = start

    def poke():
        nonlocal peak
        peak = max(peak, current_rss_mb())

    class Tracker:
        def poke(self_inner):
            poke()

        @property
        def peak_mb(self_inner):
            return peak

        @property
        def delta_mb(self_inner):
            return peak - start

    t = Tracker()
    yield t
    poke()


def audio_stats(audio: np.ndarray, sr: int) -> dict:
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    if x.size == 0:
        return {"duration_sec": 0.0, "peak": 0.0, "rms": 0.0}
    return {
        "duration_sec": float(len(x) / max(sr, 1)),
        "peak": float(np.max(np.abs(x))),
        "rms": float(np.sqrt(np.mean(x**2))),
    }


def timed(fn):
    t0 = time.perf_counter()
    result = fn()
    return result, time.perf_counter() - t0
