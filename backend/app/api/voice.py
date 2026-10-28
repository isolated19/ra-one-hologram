"""Offline Piper TTS API — synthesize / presets / status / preview."""

from __future__ import annotations

import asyncio
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from app.core.logging import get_logger
from app.voice.OfflineTTSEngine import get_tts_engine
from app.voice.VoiceConfig import DEFAULT_PRESET, MAX_TEXT_CHARS
from app.voice.VoicePresetManager import VoicePresetManager

logger = get_logger(__name__)
router = APIRouter(prefix="/api/voice", tags=["voice"])

# Serialize heavy synthesis to protect the i7-8650U under concurrent load
_synth_lock = asyncio.Lock()


class VoiceCapabilities(BaseModel):
    module: str = "2+offline-tts"
    server_stt: bool = True
    stt_engine: str = "vosk+faster-whisper"
    server_tts: bool = True
    tts_engine: str = "piper"
    wake_word_engine: str = "vosk-grammar+whisper-verify"
    clap_detection: str = "browser-web-audio"
    mock_responses: bool = True
    cloud_tts: bool = False
    notes: list[str] = Field(
        default_factory=lambda: [
            "Speech synthesis uses local Piper ONNX models + cinematic FX.",
            "No ElevenLabs / cloud TTS / browser SpeechSynthesis for RA-ONE voice.",
            "Wake word and question STT run offline on the backend via /ws/stt.",
            "Clap detection still runs in the browser (Web Audio).",
            "No LLM is connected.",
        ]
    )


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_TEXT_CHARS)
    preset: str = Field(default=DEFAULT_PRESET)
    voice_id: str | None = None
    use_phonetic: bool = False
    pitch_semitones: float | None = Field(default=None, ge=-8, le=8)
    speed: float | None = Field(default=None, ge=0.5, le=1.5)
    bass_gain_db: float | None = Field(default=None, ge=-6, le=12)
    saturation: float | None = Field(default=None, ge=0, le=1)
    mechanical: float | None = Field(default=None, ge=0, le=1)
    reverb_mix: float | None = Field(default=None, ge=0, le=0.7)

    @field_validator("text")
    @classmethod
    def strip_text(cls, v: str) -> str:
        cleaned = " ".join(v.split()).strip()
        if not cleaned:
            raise ValueError("Text is empty")
        return cleaned


class PreviewRequest(SynthesizeRequest):
    """Same payload as synthesize; reserved for short test lines."""

    pass


def _overrides_from_body(body: SynthesizeRequest) -> dict[str, Any]:
    raw = {
        "pitch_semitones": body.pitch_semitones,
        "speed": body.speed,
        "bass_gain_db": body.bass_gain_db,
        "saturation": body.saturation,
        "mechanical": body.mechanical,
        "reverb_mix": body.reverb_mix,
    }
    return {k: v for k, v in raw.items() if v is not None}


async def _run_synth(body: SynthesizeRequest):
    engine = get_tts_engine()
    if not engine.available and not engine.list_installed_voices():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No Piper voice models installed. Run scripts/download_piper_voices.py",
        )
    overrides = _overrides_from_body(body)
    loop = asyncio.get_running_loop()

    async with _synth_lock:
        try:
            result = await loop.run_in_executor(
                None,
                lambda: engine.synthesize_sync(
                    body.text,
                    preset=body.preset,
                    voice_id=body.voice_id,
                    overrides=overrides or None,
                    use_phonetic=body.use_phonetic,
                ),
            )
        except KeyError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            logger.exception("Synthesis failed")
            raise HTTPException(status_code=500, detail=f"Synthesis failed: {exc}") from exc
    return result


@router.get("/capabilities", response_model=VoiceCapabilities)
async def voice_capabilities() -> VoiceCapabilities:
    return VoiceCapabilities()


@router.get("/status")
async def voice_status() -> dict[str, Any]:
    return get_tts_engine().status()


@router.get("/presets")
async def voice_presets() -> dict[str, Any]:
    mgr = VoicePresetManager()
    return {
        "default_preset": mgr.default_preset,
        "default_voice": mgr.default_voice,
        "presets": mgr.list_presets(),
        "installed_voices": get_tts_engine().list_installed_voices(),
    }


@router.post("/synthesize")
async def synthesize(body: SynthesizeRequest) -> Response:
    result = await _run_synth(body)
    headers = {
        "X-RAONE-Voice-Id": result.voice_id,
        "X-RAONE-Preset": result.preset_id,
        "X-RAONE-Latency-Ms": f"{result.latency_ms:.1f}",
        "X-RAONE-Duration-Sec": f"{result.duration_sec:.3f}",
        "X-RAONE-Peak": f"{result.peak:.4f}",
        "X-RAONE-Clipped": "1" if result.clipped else "0",
        "X-RAONE-Piper-Version": result.piper_version,
        # Headers must be latin-1; LLM replies can contain emoji, em dashes, curly quotes.
        "X-RAONE-Spoken-Text": quote(result.spoken_text[:200]),
        "Cache-Control": "no-store",
    }
    return Response(content=result.wav_bytes, media_type="audio/wav", headers=headers)


@router.post("/preview")
async def preview(body: PreviewRequest) -> Response:
    """Same as synthesize; intended for the voice test panel."""
    if len(body.text) > 280:
        raise HTTPException(status_code=422, detail="Preview text limited to 280 characters")
    return await synthesize(body)
