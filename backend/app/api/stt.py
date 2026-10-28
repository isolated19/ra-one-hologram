"""Offline STT API — status, one-shot WAV transcription, and the streaming /ws/stt socket."""

from __future__ import annotations

import asyncio
import io
import json
from math import gcd
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect, status

from app.core.logging import get_logger
from app.stt.STTConfig import FRAME_MS, SAMPLE_RATE
from app.stt.STTSession import STTSession

logger = get_logger(__name__)
router = APIRouter(tags=["stt"])

MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def _engine(app) -> Any:
    return app.state.stt_engine


def wav_to_pcm16k(data: bytes) -> bytes:
    """Decode any WAV/FLAC soundfile can read into 16 kHz mono PCM16."""
    import soundfile as sf
    from scipy.signal import resample_poly

    audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    mono = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        g = gcd(sr, SAMPLE_RATE)
        mono = resample_poly(mono, SAMPLE_RATE // g, sr // g)
    return (np.clip(mono, -1.0, 1.0) * 32767).astype(np.int16).tobytes()


@router.get("/api/stt/status")
async def stt_status(request: Request) -> dict[str, Any]:
    return _engine(request.app).status()


@router.post("/api/stt/transcribe")
async def stt_transcribe(request: Request) -> dict[str, Any]:
    """Body: raw WAV bytes. Debug/test path; the live assistant uses /ws/stt."""
    engine = _engine(request.app)
    if not engine.available:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Offline STT models missing. Run scripts/download_stt_models.py",
        )
    body = await request.body()
    if not body or len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=422, detail="Send a WAV body up to 10 MB")
    try:
        pcm = wav_to_pcm16k(body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Unreadable audio: {exc}") from exc
    result = await asyncio.get_running_loop().run_in_executor(None, engine.transcribe, pcm)
    return {
        "text": result.text,
        "latency_ms": round(result.latency_ms, 1),
        "audio_sec": round(result.audio_sec, 2),
    }


@router.websocket("/ws/stt")
async def stt_socket(websocket: WebSocket) -> None:
    """
    Client → server: binary 16 kHz mono PCM16 frames; JSON text
      {"cmd": "mode", "value": "wake"|"question"|"off", "seq"?, "grace_ms"?, "silence_ms"?, "max_ms"?}
      {"cmd": "ping"}
    Server → client: JSON events (ready, mode, partial, wake, wake_rejected,
      speech_start, final, empty, error, pong). Mode-driven events carry the request's "seq".
    """
    await websocket.accept()
    engine = _engine(websocket.app)
    loop = asyncio.get_running_loop()

    async def send_all(events: list[dict[str, Any]], seq: int | None) -> None:
        for ev in events:
            await websocket.send_json({**ev, "seq": seq})

    if not engine.available:
        await websocket.send_json(
            {
                "type": "error",
                "error": "models-missing",
                "message": "Offline STT models missing. Run scripts/download_stt_models.py",
            }
        )
        await websocket.close(code=1011)
        return

    try:
        session = await loop.run_in_executor(None, STTSession, engine)
    except Exception as exc:
        logger.exception("STT session init failed")
        await websocket.send_json({"type": "error", "error": "init-failed", "message": str(exc)})
        await websocket.close(code=1011)
        return

    await websocket.send_json(
        {"type": "ready", "mode": session.mode, "sample_rate": SAMPLE_RATE, "frame_ms": FRAME_MS}
    )
    try:
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                if session.mode == "off":
                    continue
                seq = session.seq
                events = await loop.run_in_executor(None, session.feed, msg["bytes"])
                await send_all(events, seq)
                continue
            try:
                cmd = json.loads(msg.get("text") or "{}")
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "error": "bad-json"})
                continue
            if cmd.get("cmd") == "ping":
                await websocket.send_json({"type": "pong", "mode": session.mode})
            elif cmd.get("cmd") == "mode":
                events = await loop.run_in_executor(
                    None,
                    lambda: session.set_mode(
                        str(cmd.get("value", "off")),
                        grace_ms=cmd.get("grace_ms"),
                        silence_ms=cmd.get("silence_ms"),
                        max_ms=cmd.get("max_ms"),
                        seq=cmd.get("seq"),
                    ),
                )
                await send_all(events, cmd.get("seq"))
            else:
                await websocket.send_json({"type": "error", "error": "bad-cmd"})
    except WebSocketDisconnect:
        pass
