"""Validate a user-owned reference WAV before voice cloning."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import soundfile as sf


@dataclass
class ReferenceReport:
    path: str
    exists: bool
    ok: bool
    errors: list[str]
    warnings: list[str]
    duration_sec: float = 0.0
    sample_rate: int = 0
    channels: int = 0
    subtype: str = ""
    peak: float = 0.0
    rms: float = 0.0
    clipped: bool = False
    silent_ratio: float = 0.0
    format_ok: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def validate_reference(
    path: str | Path,
    *,
    min_duration: float = 3.0,
    max_duration: float = 120.0,
    preferred_sr: tuple[int, ...] = (16000, 22050, 24000, 44100, 48000),
) -> ReferenceReport:
    p = Path(path)
    errors: list[str] = []
    warnings: list[str] = []
    report = ReferenceReport(
        path=str(p.resolve()) if p.exists() else str(p),
        exists=p.exists(),
        ok=False,
        errors=errors,
        warnings=warnings,
    )
    if not p.exists():
        errors.append("Reference file not found. Place your owned recording at this path.")
        return report
    if p.suffix.lower() not in {".wav", ".flac", ".ogg"}:
        errors.append(f"Unsupported format {p.suffix!r}; use WAV (preferred), FLAC, or OGG.")
        return report

    try:
        info = sf.info(str(p))
        audio, sr = sf.read(str(p), always_2d=True, dtype="float32")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"Could not read audio: {exc}")
        return report

    report.sample_rate = int(info.samplerate)
    report.channels = int(info.channels)
    report.subtype = str(info.subtype)
    report.duration_sec = float(info.duration)
    report.format_ok = True

    mono = audio.mean(axis=1)
    report.peak = float(np.max(np.abs(mono)) if mono.size else 0.0)
    report.rms = float(np.sqrt(np.mean(mono**2)) if mono.size else 0.0)
    report.clipped = report.peak >= 0.99
    silent = np.mean(np.abs(mono) < 0.01) if mono.size else 1.0
    report.silent_ratio = float(silent)

    if report.duration_sec < min_duration:
        errors.append(f"Duration {report.duration_sec:.2f}s < recommended {min_duration}s.")
    if report.duration_sec > max_duration:
        warnings.append(f"Duration {report.duration_sec:.1f}s is long; engines may truncate.")
    if report.channels > 2:
        warnings.append(f"{report.channels} channels — will be mixed to mono.")
    if report.sample_rate not in preferred_sr:
        warnings.append(f"Sample rate {report.sample_rate} Hz is unusual; may be resampled.")
    if report.clipped:
        warnings.append("Possible clipping detected (peak ≥ 0.99).")
    if report.silent_ratio > 0.55:
        warnings.append(f"Large silent sections ({report.silent_ratio:.0%}).")
    if report.rms < 0.01:
        errors.append("Audio is too quiet / nearly silent.")

    report.ok = len(errors) == 0
    return report
