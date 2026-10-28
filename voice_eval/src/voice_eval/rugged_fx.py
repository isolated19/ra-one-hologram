"""Adjustable Dark / Cosmic / Commander post-FX for eval WAVs."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import signal

PRESETS = {
    "none": {},
    "dark": {
        "pitch_semitones": -1.5,
        "bass_gain_db": 4.5,
        "bass_cutoff_hz": 160.0,
        "saturation": 0.18,
        "reverb_mix": 0.12,
        "reverb_delay_ms": 45.0,
        "reverb_decay": 0.32,
    },
    "cosmic": {
        "pitch_semitones": -0.8,
        "bass_gain_db": 3.0,
        "bass_cutoff_hz": 140.0,
        "saturation": 0.12,
        "reverb_mix": 0.22,
        "reverb_delay_ms": 70.0,
        "reverb_decay": 0.42,
    },
    "commander": {
        "pitch_semitones": -2.0,
        "bass_gain_db": 5.5,
        "bass_cutoff_hz": 180.0,
        "saturation": 0.22,
        "reverb_mix": 0.08,
        "reverb_delay_ms": 35.0,
        "reverb_decay": 0.28,
    },
}


@dataclass
class FxParams:
    pitch_semitones: float = 0.0
    bass_gain_db: float = 0.0
    bass_cutoff_hz: float = 180.0
    saturation: float = 0.0
    reverb_mix: float = 0.0
    reverb_delay_ms: float = 50.0
    reverb_decay: float = 0.35


def get_preset(name: str) -> FxParams:
    raw = PRESETS.get((name or "none").lower(), {})
    fields = FxParams.__dataclass_fields__
    return FxParams(**{k: v for k, v in raw.items() if k in fields})


def apply_fx(audio: np.ndarray, sample_rate: int, preset: str = "none") -> np.ndarray:
    params = get_preset(preset)
    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    if x.size == 0 or preset.lower() in ("", "none"):
        return _limit(x)

    peak = float(np.max(np.abs(x)) or 1.0)
    x = x / peak * 0.9

    if abs(params.pitch_semitones) > 0.05:
        x = _pitch_shift_simple(x, sample_rate, params.pitch_semitones)
    if abs(params.bass_gain_db) > 0.1:
        x = _bass(x, sample_rate, params.bass_gain_db, params.bass_cutoff_hz)
    if params.saturation > 0.01:
        x = np.tanh(x * (1.0 + params.saturation * 3.0)) / np.tanh(1.0 + params.saturation * 3.0)
    if params.reverb_mix > 0.01:
        x = _reverb(x, sample_rate, params.reverb_mix, params.reverb_delay_ms, params.reverb_decay)
    return _limit(x)


def _pitch_shift_simple(x: np.ndarray, sr: int, semitones: float) -> np.ndarray:
    """Resample-based pitch shift (no librosa dependency in base venv)."""
    factor = 2.0 ** (semitones / 12.0)
    # Change pitch by resampling, then restore duration via linear stretch
    n = max(2, int(len(x) / factor))
    idx = np.linspace(0, len(x) - 1, n)
    pitched = np.interp(idx, np.arange(len(x)), x).astype(np.float32)
    # Restore approximate original length
    out_idx = np.linspace(0, len(pitched) - 1, len(x))
    return np.interp(out_idx, np.arange(len(pitched)), pitched).astype(np.float32)


def _bass(x: np.ndarray, sr: int, gain_db: float, cutoff: float) -> np.ndarray:
    sos = signal.butter(2, cutoff, btype="low", fs=sr, output="sos")
    low = signal.sosfilt(sos, x)
    g = 10.0 ** (gain_db / 20.0)
    return (x + low * (g - 1.0)).astype(np.float32)


def _reverb(x: np.ndarray, sr: int, mix: float, delay_ms: float, decay: float) -> np.ndarray:
    delay = max(1, int(sr * delay_ms / 1000.0))
    wet = np.zeros_like(x)
    if delay < len(x):
        wet[delay:] = x[:-delay] * decay
        wet[delay * 2 :] += x[: -delay * 2] * (decay**2) if delay * 2 < len(x) else 0
    return ((1.0 - mix) * x + mix * wet).astype(np.float32)


def _limit(x: np.ndarray, peak: float = 0.95) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    m = float(np.max(np.abs(x)) or 1.0)
    if m > peak:
        x = x * (peak / m)
    return x
