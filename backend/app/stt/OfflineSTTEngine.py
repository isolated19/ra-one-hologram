"""
Offline speech-to-text: Vosk (cheap always-on wake gate) + faster-whisper (accurate transcripts).

Both models are loaded lazily and shared across WebSocket sessions. Whisper calls are
serialized because the i7-8650U has no headroom for two concurrent decodes.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from app.assistant.identity_config import WAKE_DICTIONARY
from app.core.logging import get_logger

from .STTConfig import (
    SAMPLE_RATE,
    VOSK_MODEL_DIR,
    WHISPER_COMPUTE_TYPE,
    WHISPER_INITIAL_PROMPT,
    WHISPER_MODEL_DIR,
    WHISPER_MODEL_SIZE,
    WHISPER_THREADS,
)

logger = get_logger(__name__)

try:
    import vosk

    vosk.SetLogLevel(-1)
    VOSK_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover
    vosk = None  # type: ignore
    VOSK_IMPORT_ERROR = exc

try:
    from faster_whisper import WhisperModel

    WHISPER_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # pragma: no cover
    WhisperModel = None  # type: ignore
    WHISPER_IMPORT_ERROR = exc

# Whisper emits these on near-silence; never treat them as a question
_HALLUCINATIONS = {"", "you", "thank you", "thanks for watching", "bye", "uh", "um"}


def build_wake_grammar() -> list[str]:
    """Phrases Vosk may output in wake mode; everything else collapses to [unk]."""
    # Single-token spellings ("raone") are not in the small Vosk vocabulary; it can only
    # produce the spaced forms, so leave them out instead of logging a warning per session.
    names = {a.replace("-", " ") for a in WAKE_DICTIONARY["name_aliases"]}
    names = {n for n in names if " " in n}
    phrases: set[str] = set(names)
    for greet in WAKE_DICTIONARY["greetings"]:
        phrases.update(f"{greet} {n}" for n in names)
    return sorted(phrases) + ["[unk]"]


@dataclass
class TranscriptResult:
    text: str
    latency_ms: float
    audio_sec: float


class OfflineSTTEngine:
    def __init__(self) -> None:
        self._vosk_model: Any = None
        self._whisper: Any = None
        self._load_lock = threading.Lock()
        self._whisper_lock = threading.Lock()
        self._grammar_json = json.dumps(build_wake_grammar())
        self.last_error: str | None = None
        self._warmed = False

    # ── availability ──────────────────────────────────────────────
    @property
    def vosk_installed(self) -> bool:
        return vosk is not None and (VOSK_MODEL_DIR / "am").exists()

    @property
    def whisper_installed(self) -> bool:
        return WhisperModel is not None and (WHISPER_MODEL_DIR / "model.bin").exists()

    @property
    def available(self) -> bool:
        return self.vosk_installed and self.whisper_installed

    def preload(self) -> bool:
        if self._warmed:
            return True
        try:
            self._get_vosk()
            self._get_whisper()
            # Warm-up decode so the first real question is not slow
            self.transcribe(np.zeros(SAMPLE_RATE // 2, dtype=np.int16).tobytes())
            self._warmed = True
            return True
        except Exception as exc:
            self.last_error = str(exc)
            logger.warning("Offline STT preload failed: %s", exc)
            return False

    def _get_vosk(self) -> Any:
        if self._vosk_model is None:
            with self._load_lock:
                if self._vosk_model is None:
                    if not self.vosk_installed:
                        raise FileNotFoundError(
                            f"Vosk model missing at {VOSK_MODEL_DIR}. Run scripts/download_stt_models.py"
                        )
                    t = time.perf_counter()
                    self._vosk_model = vosk.Model(str(VOSK_MODEL_DIR))
                    logger.info("Vosk model loaded in %.0f ms", (time.perf_counter() - t) * 1000)
        return self._vosk_model

    def _get_whisper(self) -> Any:
        if self._whisper is None:
            with self._load_lock:
                if self._whisper is None:
                    if not self.whisper_installed:
                        raise FileNotFoundError(
                            f"Whisper model missing at {WHISPER_MODEL_DIR}. Run scripts/download_stt_models.py"
                        )
                    t = time.perf_counter()
                    self._whisper = WhisperModel(
                        str(WHISPER_MODEL_DIR),
                        device="cpu",
                        compute_type=WHISPER_COMPUTE_TYPE,
                        cpu_threads=WHISPER_THREADS,
                    )
                    logger.info(
                        "Whisper %s loaded in %.0f ms", WHISPER_MODEL_SIZE, (time.perf_counter() - t) * 1000
                    )
        return self._whisper

    # ── recognizers ───────────────────────────────────────────────
    def new_wake_recognizer(self) -> Any:
        rec = vosk.KaldiRecognizer(self._get_vosk(), SAMPLE_RATE, self._grammar_json)
        rec.SetWords(True)
        return rec

    def new_partial_recognizer(self) -> Any:
        """Full-vocabulary Vosk for live captions while whisper waits for the final."""
        return vosk.KaldiRecognizer(self._get_vosk(), SAMPLE_RATE)

    def transcribe(self, pcm16: bytes) -> TranscriptResult:
        audio = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
        audio_sec = len(audio) / SAMPLE_RATE
        model = self._get_whisper()
        t = time.perf_counter()
        with self._whisper_lock:
            segments, _info = model.transcribe(
                audio,
                language="en",
                beam_size=1,
                initial_prompt=WHISPER_INITIAL_PROMPT,
                condition_on_previous_text=False,
                without_timestamps=True,
                vad_filter=False,
            )
            parts = [
                s.text
                for s in segments
                if not (s.no_speech_prob > 0.6 and s.avg_logprob < -1.0)
            ]
        text = " ".join(p.strip() for p in parts).strip()
        if text.lower().strip(" .!?,") in _HALLUCINATIONS:
            text = ""
        return TranscriptResult(
            text=text,
            latency_ms=(time.perf_counter() - t) * 1000,
            audio_sec=audio_sec,
        )

    def status(self) -> dict[str, Any]:
        return {
            "engine": "vosk+faster-whisper",
            "offline": True,
            "available": self.available,
            "vosk_installed": self.vosk_installed,
            "vosk_loaded": self._vosk_model is not None,
            "vosk_model": VOSK_MODEL_DIR.name,
            "whisper_installed": self.whisper_installed,
            "whisper_loaded": self._whisper is not None,
            "whisper_model": WHISPER_MODEL_SIZE,
            "whisper_compute_type": WHISPER_COMPUTE_TYPE,
            "sample_rate": SAMPLE_RATE,
            "import_errors": {
                k: str(v)
                for k, v in {"vosk": VOSK_IMPORT_ERROR, "whisper": WHISPER_IMPORT_ERROR}.items()
                if v
            },
            "last_error": self.last_error,
        }


_engine: OfflineSTTEngine | None = None
_engine_lock = threading.Lock()


def get_stt_engine() -> OfflineSTTEngine:
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = OfflineSTTEngine()
        return _engine
