"""
Piper-based offline TTS with cached ONNX voices and cinematic FX.

Requires piper-tts 1.8.x:
  from piper import PiperVoice, SynthesisConfig
  voice.synthesize_wav(text, wav_file, syn_config=...)
"""

from __future__ import annotations

import io
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from app.core.logging import get_logger

from .AudioOutputManager import AudioOutputManager
from .VoiceConfig import (
    DEFAULT_VOICE_ID,
    DEFAULT_VOICE_IDS,
    MAX_TEXT_CHARS,
    MODELS_DIR,
)
from .VoiceEffectProcessor import EffectParams, VoiceEffectProcessor
from .VoicePresetManager import VoicePresetManager
from .pronunciation_manager import PronunciationManager

logger = get_logger(__name__)

try:
    from piper import PiperVoice, SynthesisConfig

    PIPER_IMPORT_OK = True
except Exception as exc:  # pragma: no cover
    PiperVoice = None  # type: ignore
    SynthesisConfig = None  # type: ignore
    PIPER_IMPORT_OK = False
    PIPER_IMPORT_ERROR = exc
else:
    PIPER_IMPORT_ERROR = None


@dataclass
class SynthesisResult:
    wav_bytes: bytes
    sample_rate: int
    duration_sec: float
    latency_ms: float
    voice_id: str
    preset_id: str
    peak: float
    rms: float
    clipped: bool
    piper_version: str
    display_text: str = ""
    spoken_text: str = ""


class OfflineTTSEngine:
    """Thread-safe Piper synthesizer with model cache."""

    def __init__(
        self,
        models_dir: Path | None = None,
        preset_manager: VoicePresetManager | None = None,
        max_workers: int = 1,
    ) -> None:
        self.models_dir = models_dir or MODELS_DIR
        self.presets = preset_manager or VoicePresetManager()
        self.fx = VoiceEffectProcessor()
        self.output = AudioOutputManager()
        self.pronunciation = PronunciationManager()
        self._voices: dict[str, Any] = {}
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="raone-tts")
        self._piper_version = self._detect_piper_version()

    @staticmethod
    def _detect_piper_version() -> str:
        try:
            import importlib.metadata as md

            return md.version("piper-tts")
        except Exception:
            return "unknown"

    @property
    def piper_version(self) -> str:
        return self._piper_version

    @property
    def available(self) -> bool:
        return PIPER_IMPORT_OK and bool(self.list_installed_voices())

    def list_installed_voices(self) -> list[dict[str, str]]:
        self.models_dir.mkdir(parents=True, exist_ok=True)
        found: list[dict[str, str]] = []
        for onnx in sorted(self.models_dir.glob("*.onnx")):
            cfg = Path(str(onnx) + ".json")
            # piper also uses voice.onnx.json beside voice.onnx
            if not cfg.exists():
                alt = onnx.with_suffix(".onnx.json")
                cfg = alt if alt.exists() else cfg
            found.append(
                {
                    "id": onnx.stem,
                    "onnx": str(onnx),
                    "config": str(cfg) if cfg.exists() else "",
                    "ready": cfg.exists(),
                }
            )
        return found

    def _resolve_onnx(self, voice_id: str) -> Path:
        path = self.models_dir / f"{voice_id}.onnx"
        if not path.exists():
            raise FileNotFoundError(
                f"Voice model '{voice_id}' not found in {self.models_dir}. "
                f"Run: python -m piper.download_voices {voice_id} --data-dir {self.models_dir}"
            )
        return path

    def get_voice(self, voice_id: str) -> Any:
        if not PIPER_IMPORT_OK:
            raise RuntimeError(f"piper-tts not available: {PIPER_IMPORT_ERROR}")
        with self._lock:
            if voice_id in self._voices:
                return self._voices[voice_id]
            onnx = self._resolve_onnx(voice_id)
            logger.info("Loading Piper voice %s (v%s)", voice_id, self._piper_version)
            voice = PiperVoice.load(str(onnx), use_cuda=False)
            self._voices[voice_id] = voice
            return voice

    def preload(self, voice_ids: list[str] | None = None) -> list[str]:
        ids = voice_ids or list(DEFAULT_VOICE_IDS)
        loaded = []
        for vid in ids:
            try:
                self.get_voice(vid)
                loaded.append(vid)
            except Exception as exc:
                logger.warning("Could not preload %s: %s", vid, exc)
        return loaded

    def warm_up(self) -> None:
        """One throwaway synthesis: librosa's first time_stretch costs seconds (20 s under load)."""
        if not self.available:
            return
        t = time.perf_counter()
        try:
            self.synthesize_sync("Ready.")
            logger.info("Offline TTS warm-up done in %.0f ms", (time.perf_counter() - t) * 1000)
        except Exception as exc:
            logger.warning("Offline TTS warm-up failed: %s", exc)

    def synthesize_sync(
        self,
        text: str,
        *,
        preset: str | None = None,
        voice_id: str | None = None,
        overrides: dict[str, Any] | None = None,
        use_phonetic: bool = False,
        skip_pronunciation: bool = False,
    ) -> SynthesisResult:
        cleaned = " ".join(str(text).split()).strip()
        if not cleaned:
            raise ValueError("Text is empty")
        if len(cleaned) > MAX_TEXT_CHARS:
            raise ValueError(f"Text exceeds {MAX_TEXT_CHARS} characters")

        t0 = time.perf_counter()
        preset_cfg = self.presets.get_preset(preset)
        preset_id = preset_cfg["id"]
        vid = voice_id or preset_cfg.get("voice_id") or self.presets.default_voice or DEFAULT_VOICE_ID
        effects = self.presets.to_effect_params(preset_cfg, overrides)

        if skip_pronunciation:
            spoken = cleaned
            display = cleaned
        else:
            prep = self.pronunciation.prepare_for_tts(
                cleaned, voice_id=vid, use_phonetic=use_phonetic
            )
            display = prep["display_text"]
            spoken = prep["spoken_text"]

        voice = self.get_voice(vid)
        length_scale = float(preset_cfg.get("length_scale", 1.0))
        if overrides and "length_scale" in overrides:
            length_scale = float(overrides["length_scale"])

        syn_config = SynthesisConfig(
            volume=1.0,
            length_scale=length_scale,
            noise_scale=0.667,
            noise_w_scale=0.8,
            normalize_audio=True,
        )

        # Synthesize spoken form (e.g. Raw-One) — display text stays RA-ONE in UI
        raw_buf = io.BytesIO()
        with self._lock:
            # PiperVoice is not guaranteed thread-safe; serialize synthesis per process
            with wave.open(raw_buf, "wb") as wf:
                voice.synthesize_wav(spoken, wf, syn_config=syn_config)

        raw_buf.seek(0)
        with wave.open(raw_buf, "rb") as wf:
            sr = wf.getframerate()
            channels = wf.getnchannels()
            sw = wf.getsampwidth()
            frames = wf.readframes(wf.getnframes())

        if sw != 2:
            raise RuntimeError(f"Unexpected sample width {sw}")
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            audio = audio.reshape(-1, channels).mean(axis=1)

        processed = self.fx.process(audio, sr, effects)
        peak, rms = self.output.peak_and_rms(processed)
        clipped = VoiceEffectProcessor.is_clipped(processed, 0.995)
        wav_bytes = self.output.to_wav_bytes(processed, sr)
        latency_ms = (time.perf_counter() - t0) * 1000.0
        duration = len(processed) / float(sr) if sr else 0.0

        return SynthesisResult(
            wav_bytes=wav_bytes,
            sample_rate=sr,
            duration_sec=duration,
            latency_ms=latency_ms,
            voice_id=vid,
            preset_id=preset_id,
            peak=peak,
            rms=rms,
            clipped=clipped,
            piper_version=self._piper_version,
            display_text=display,
            spoken_text=spoken,
        )

    def synthesize_async(self, *args, **kwargs):
        """Run synthesize_sync in the worker pool (non-blocking for asyncio)."""
        return self._executor.submit(self.synthesize_sync, *args, **kwargs)

    def status(self) -> dict[str, Any]:
        voices = self.list_installed_voices()
        return {
            "engine": "piper",
            "piper_version": self._piper_version,
            "piper_import_ok": PIPER_IMPORT_OK,
            "piper_import_error": str(PIPER_IMPORT_ERROR) if PIPER_IMPORT_ERROR else None,
            "offline": True,
            "cloud_tts": False,
            "models_dir": str(self.models_dir),
            "installed_voices": voices,
            "cached_voices": list(self._voices.keys()),
            "default_voice": self.presets.default_voice,
            "default_preset": self.presets.default_preset,
            "max_text_chars": MAX_TEXT_CHARS,
            "ready": self.available,
        }

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)


# Process singleton used by FastAPI
_engine: OfflineTTSEngine | None = None
_engine_lock = threading.Lock()


def get_tts_engine() -> OfflineTTSEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = OfflineTTSEngine()
        return _engine
