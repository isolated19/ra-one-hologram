"""Offline Piper TTS API tests (skip synthesis if models missing)."""

from __future__ import annotations

from pathlib import Path

import pytest

MODELS = Path(__file__).resolve().parents[1] / "models" / "piper"
HAS_MODELS = any(MODELS.glob("*.onnx"))


def test_voice_status(client):
    r = client.get("/api/voice/status")
    assert r.status_code == 200
    data = r.json()
    assert data["engine"] == "piper"
    assert data["cloud_tts"] is False
    assert data["offline"] is True
    assert "piper_version" in data


def test_voice_presets(client):
    r = client.get("/api/voice/presets")
    assert r.status_code == 200
    data = r.json()
    ids = {p["id"] for p in data["presets"]}
    assert {"raone_classic", "raone_dark", "raone_cosmic", "raone_commander"} <= ids


def test_synthesize_rejects_empty(client):
    r = client.post("/api/voice/synthesize", json={"text": "   ", "preset": "raone_classic"})
    assert r.status_code == 422


@pytest.mark.skipif(not HAS_MODELS, reason="Piper models not downloaded")
def test_synthesize_returns_wav(client):
    r = client.post(
        "/api/voice/synthesize",
        json={"text": "I am RA-ONE.", "preset": "raone_commander"},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/wav")
    assert r.content[:4] == b"RIFF"
    assert float(r.headers.get("X-RAONE-Latency-Ms", "0")) > 0
    assert r.headers.get("X-RAONE-Clipped") == "0"


@pytest.mark.skipif(not HAS_MODELS, reason="Piper models not downloaded")
def test_synthesize_non_latin1_reply(client):
    # LLM replies with emoji / em dash used to crash on the spoken-text header
    r = client.post(
        "/api/voice/synthesize",
        json={"text": "📝 Two plus two is four — easy.", "preset": "raone_commander"},
    )
    assert r.status_code == 200
    assert r.content[:4] == b"RIFF"


@pytest.mark.skipif(not HAS_MODELS, reason="Piper models not downloaded")
def test_preview_all_presets(client):
    for preset in ("raone_classic", "raone_dark", "raone_cosmic", "raone_commander"):
        r = client.post(
            "/api/voice/preview",
            json={"text": "Systems online.", "preset": preset},
        )
        assert r.status_code == 200, preset
        assert r.content[:4] == b"RIFF"
