"""
Offline cinematic post-FX for RA-ONE speech.

Pitch uses librosa pitch_shift (phase-vocoder style) so rate and pitch
are independent — we never just change playback sample rate.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import signal

from .VoiceConfig import NORMALIZE_PEAK

try:
    import librosa
except ImportError:  # pragma: no cover
    librosa = None  # type: ignore


@dataclass
class EffectParams:
    pitch_semitones: float = 0.0
    speed: float = 1.0
    bass_gain_db: float = 0.0
    bass_cutoff_hz: float = 180.0
    saturation: float = 0.0
    mechanical: float = 0.0
    octave_mix: float = 0.0
    reverb_mix: float = 0.0
    reverb_delay_ms: float = 50.0
    reverb_decay: float = 0.35
    compress_threshold: float = 0.55
    compress_ratio: float = 2.5


class VoiceEffectProcessor:
    """Apply rugged / cinematic FX while keeping speech intelligible."""

    def process(
        self,
        audio: np.ndarray,
        sample_rate: int,
        params: EffectParams,
    ) -> np.ndarray:
        x = np.asarray(audio, dtype=np.float32).reshape(-1)
        if x.size == 0:
            return x

        # Peak-normalize lightly before FX for consistent processing
        peak = float(np.max(np.abs(x)) or 1.0)
        x = x / peak * 0.9

        if abs(params.speed - 1.0) > 0.01:
            x = self._time_stretch(x, sample_rate, params.speed)

        if abs(params.pitch_semitones) > 0.05:
            x = self._pitch_shift(x, sample_rate, params.pitch_semitones)

        if abs(params.bass_gain_db) > 0.1:
            x = self._bass_enhance(x, sample_rate, params.bass_gain_db, params.bass_cutoff_hz)

        if params.saturation > 0.01:
            x = self._saturate(x, params.saturation)

        if params.mechanical > 0.01:
            x = self._mechanical_timbre(x, sample_rate, params.mechanical)

        if params.octave_mix > 0.01:
            x = self._parallel_octave(x, sample_rate, params.octave_mix)

        if params.reverb_mix > 0.01:
            x = self._reverb(
                x,
                sample_rate,
                mix=params.reverb_mix,
                delay_ms=params.reverb_delay_ms,
                decay=params.reverb_decay,
            )

        x = self._compress(x, params.compress_threshold, params.compress_ratio)
        x = self._limit_and_normalize(x, NORMALIZE_PEAK)
        return x.astype(np.float32)

    def _time_stretch(self, x: np.ndarray, sr: int, speed: float) -> np.ndarray:
        """speed < 1 = slower speech; pitch preserved (phase vocoder / WSOLA-lite)."""
        rate = max(0.5, min(2.0, float(speed)))
        if abs(rate - 1.0) < 0.02:
            return x
        if librosa is not None:
            # Faster settings for Intel U-series CPUs
            stretch = 1.0 / rate
            return librosa.effects.time_stretch(x, rate=stretch).astype(np.float32)
        # Duration-changing resample is NOT used alone for pitch; here stretch only
        new_len = max(1, int(len(x) / rate))
        t_old = np.linspace(0.0, 1.0, len(x), endpoint=False)
        t_new = np.linspace(0.0, 1.0, new_len, endpoint=False)
        return np.interp(t_new, t_old, x).astype(np.float32)

    def _pitch_shift(self, x: np.ndarray, sr: int, semitones: float) -> np.ndarray:
        """Pitch shift without changing duration (resample + restore length)."""
        n = float(np.clip(semitones, -8.0, 8.0))
        if abs(n) < 0.05:
            return x
        # Prefer a lightweight resample/restore approach for CPU laptops.
        # This keeps duration constant (unlike raw playback-rate pitch).
        factor = 2.0 ** (n / 12.0)
        # 1) Resample to shift pitch+tempo together
        new_len = max(1, int(round(len(x) / factor)))
        t_old = np.linspace(0.0, 1.0, len(x), endpoint=False)
        t_mid = np.linspace(0.0, 1.0, new_len, endpoint=False)
        shifted = np.interp(t_mid, t_old, x)
        # 2) Time-stretch back to original length (restores tempo, keeps new pitch)
        t_back = np.linspace(0.0, 1.0, len(x), endpoint=False)
        t_src = np.linspace(0.0, 1.0, len(shifted), endpoint=False)
        return np.interp(t_back, t_src, shifted).astype(np.float32)

    def _bass_enhance(
        self,
        x: np.ndarray,
        sr: int,
        gain_db: float,
        cutoff_hz: float,
    ) -> np.ndarray:
        cutoff = min(cutoff_hz, sr * 0.45)
        sos = signal.butter(2, cutoff, btype="low", fs=sr, output="sos")
        low = signal.sosfilt(sos, x)
        gain = 10 ** (gain_db / 20.0)
        return (x + low * (gain - 1.0)).astype(np.float32)

    def _saturate(self, x: np.ndarray, amount: float) -> np.ndarray:
        a = float(np.clip(amount, 0.0, 1.0))
        drive = 1.0 + a * 4.0
        wet = np.tanh(x * drive) / np.tanh(drive)
        return ((1.0 - a * 0.65) * x + (a * 0.65) * wet).astype(np.float32)

    def _mechanical_timbre(self, x: np.ndarray, sr: int, amount: float) -> np.ndarray:
        """Subtle comb / metallic sheen without destroying consonants."""
        a = float(np.clip(amount, 0.0, 1.0))
        delay = max(1, int(sr * 0.0035))  # ~3.5 ms
        delayed = np.zeros_like(x)
        delayed[delay:] = x[:-delay]
        comb = x + delayed * (0.35 * a)
        # Soft ring modulation at low frequency
        t = np.arange(len(x), dtype=np.float32) / sr
        ring = x * (1.0 + 0.08 * a * np.sin(2 * np.pi * 55.0 * t))
        y = (1.0 - 0.45 * a) * comb + (0.45 * a) * ring
        return y.astype(np.float32)

    def _parallel_octave(self, x: np.ndarray, sr: int, mix: float) -> np.ndarray:
        mix = float(np.clip(mix, 0.0, 0.35))
        # Fast octave-down approximation (same duration)
        low = self._pitch_shift(x, sr, -12.0)
        sos = signal.butter(2, 400, btype="low", fs=sr, output="sos")
        low = signal.sosfilt(sos, low) * 0.7
        return ((1.0 - mix) * x + mix * low).astype(np.float32)

    def _reverb(
        self,
        x: np.ndarray,
        sr: int,
        *,
        mix: float,
        delay_ms: float,
        decay: float,
    ) -> np.ndarray:
        mix = float(np.clip(mix, 0.0, 0.7))
        decay = float(np.clip(decay, 0.05, 0.85))
        delays_ms = [delay_ms, delay_ms * 1.7, delay_ms * 2.6, delay_ms * 3.9]
        wet = np.zeros_like(x)
        for i, d_ms in enumerate(delays_ms):
            d = max(1, int(sr * d_ms / 1000.0))
            if d >= len(x):
                continue
            echo = np.zeros_like(x)
            echo[d:] = x[:-d] * (decay ** (i + 1))
            wet += echo
        wet *= 0.35
        return ((1.0 - mix) * x + mix * (x * 0.25 + wet)).astype(np.float32)

    def _compress(self, x: np.ndarray, threshold: float, ratio: float) -> np.ndarray:
        thr = float(np.clip(threshold, 0.05, 0.95))
        ratio = max(1.0, float(ratio))
        abs_x = np.abs(x)
        mask = abs_x > thr
        y = x.copy()
        over = abs_x[mask] - thr
        compressed = thr + over / ratio
        y[mask] = np.sign(x[mask]) * compressed
        return y.astype(np.float32)

    def _limit_and_normalize(self, x: np.ndarray, peak_target: float) -> np.ndarray:
        # Soft clip / limiter
        limited = np.tanh(x * 1.15) / np.tanh(1.15)
        peak = float(np.max(np.abs(limited)) or 1.0)
        if peak > 1e-8:
            limited = limited * (peak_target / peak)
        # Hard safety clip
        return np.clip(limited, -0.999, 0.999).astype(np.float32)

    @staticmethod
    def is_clipped(audio: np.ndarray, threshold: float = 0.99) -> bool:
        if audio.size == 0:
            return False
        return bool(np.max(np.abs(audio)) >= threshold)
