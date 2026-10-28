"""Offline STT (Module 1 desktop plan): session state machine + real-model checks.

Unit tests use fake recognizers/VAD so they are fast and deterministic.
Integration tests synthesize speech with Piper, so they need no microphone or network,
and skip when Vosk/Whisper/Piper models are not downloaded.
"""

from __future__ import annotations

import io
import json
import time
import wave
from dataclasses import dataclass

import numpy as np
import pytest

from app.stt.OfflineSTTEngine import build_wake_grammar, get_stt_engine
from app.stt.STTConfig import FRAME_BYTES, SAMPLE_RATE
from app.stt.STTSession import STTSession

SPEECH = b"\x10\x00" * (FRAME_BYTES // 2)
SILENCE = b"\x00\x00" * (FRAME_BYTES // 2)


# ── fakes ─────────────────────────────────────────────────────────
@dataclass
class FakeResult:
    text: str
    latency_ms: float = 5.0
    audio_sec: float = 1.0


class FakeRecognizer:
    """Vosk-like recognizer that emits a scripted result after N frames."""

    def __init__(self, result: dict | None = None, after_frames: int = 10**9) -> None:
        self.result = result or {"text": ""}
        self.after = after_frames
        self.frames = 0

    def AcceptWaveform(self, _frame: bytes) -> bool:
        self.frames += 1
        return self.frames == self.after

    def Result(self) -> str:
        return json.dumps(self.result)

    def PartialResult(self) -> str:
        return json.dumps({"partial": ""})

    def FinalResult(self) -> str:
        return self.Result()


class FakeEngine:
    def __init__(self, transcript: str = "what time is it", wake: FakeRecognizer | None = None) -> None:
        self.transcript = transcript
        self.wake = wake or FakeRecognizer()
        self.transcribed: list[int] = []

    def new_wake_recognizer(self):
        return self.wake

    def new_partial_recognizer(self):
        return FakeRecognizer()

    def transcribe(self, pcm: bytes) -> FakeResult:
        self.transcribed.append(len(pcm))
        return FakeResult(self.transcript)


def energy_vad(frame: bytes) -> bool:
    return any(frame)


def frames(n: int, kind: bytes) -> bytes:
    return kind * n


def types(events):
    return [e["type"] for e in events]


# ── unit: question mode ───────────────────────────────────────────
def test_question_final_after_silence():
    engine = FakeEngine("what time is it")
    s = STTSession(engine, vad=energy_vad)
    s.set_mode("question")
    ev = s.feed(frames(10, SILENCE) + frames(40, SPEECH) + frames(50, SILENCE))
    assert "speech_start" in types(ev)
    final = [e for e in ev if e["type"] == "final"]
    assert final and final[0]["text"] == "what time is it"
    assert final[0]["reason"] == "silence"
    assert s.mode == "off"
    # Pre-roll included: 40 speech frames + up to 15 pre-roll + trailing silence
    assert engine.transcribed[0] > 40 * FRAME_BYTES


def test_question_grace_timeout_emits_empty():
    s = STTSession(FakeEngine(), vad=energy_vad)
    s.set_mode("question", grace_ms=1000)
    ev = s.feed(frames(60, SILENCE))
    assert {"type": "empty", "reason": "no-speech"} in ev
    assert s.mode == "off"


def test_question_short_blip_is_noise_not_question():
    engine = FakeEngine()
    s = STTSession(engine, vad=energy_vad)
    s.set_mode("question", grace_ms=2000)
    ev = s.feed(frames(5, SPEECH) + frames(120, SILENCE))
    assert not [e for e in ev if e["type"] == "final"]
    assert any(e["type"] == "empty" for e in ev)
    assert engine.transcribed == []


def test_question_hard_cap_finalizes():
    s = STTSession(FakeEngine("long talk"), vad=energy_vad)
    s.set_mode("question", max_ms=1000)
    ev = s.feed(frames(80, SPEECH))
    final = [e for e in ev if e["type"] == "final"]
    assert final and final[0]["reason"] == "timeout"


def test_odd_chunk_sizes_are_reframed():
    s = STTSession(FakeEngine("hello"), vad=energy_vad)
    s.set_mode("question")
    blob = frames(40, SPEECH) + frames(50, SILENCE)
    ev = []
    for i in range(0, len(blob), 333):
        ev += s.feed(blob[i : i + 333])
    assert any(e["type"] == "final" for e in ev)


def test_off_mode_discards_audio():
    s = STTSession(FakeEngine(), vad=energy_vad)
    assert s.feed(frames(100, SPEECH)) == []


def test_bad_mode_rejected():
    s = STTSession(FakeEngine(), vad=energy_vad)
    assert s.set_mode("dance")[0]["error"] == "bad-mode"


# ── unit: wake mode ───────────────────────────────────────────────
def _wake_result(text, conf):
    words = [{"word": w, "conf": conf} for w in text.split()]
    return {"text": text, "result": words}


def test_confident_bare_wake_skips_whisper():
    rec = FakeRecognizer(_wake_result("hey raw one", 0.9), after_frames=20)
    engine = FakeEngine(wake=rec)
    s = STTSession(engine, vad=energy_vad)
    s.set_mode("wake")
    ev = s.feed(frames(20, SPEECH))
    wake = [e for e in ev if e["type"] == "wake"][0]
    assert wake["remainder"] == "" and wake["verified_by"] == "vosk"
    assert engine.transcribed == []
    assert s.mode == "off"


def test_wake_with_trailing_words_uses_whisper_remainder():
    rec = FakeRecognizer(_wake_result("hey ra one one [unk]", 0.7), after_frames=30)
    engine = FakeEngine("Hey RA-ONE. What time is it?", wake=rec)
    s = STTSession(engine, vad=energy_vad)
    s.set_mode("wake")
    # Vosk endpoints at frame 30 but the speaker keeps talking: no wake until they pause
    assert not [e for e in s.feed(frames(30, SPEECH) + frames(40, SPEECH)) if e["type"] == "wake"]
    ev = s.feed(frames(50, SILENCE))
    wake = [e for e in ev if e["type"] == "wake"][0]
    assert wake["verified_by"] == "whisper"
    assert wake["remainder"] == "what time is it"
    # Whisper saw the whole sentence, not just the audio up to Vosk's endpoint
    assert engine.transcribed[0] >= 70 * FRAME_BYTES


def test_low_confidence_wake_rejected_when_whisper_disagrees():
    rec = FakeRecognizer(_wake_result("raw one", 0.4), after_frames=10)
    s = STTSession(FakeEngine("rowing on the lake", wake=rec), vad=energy_vad)
    s.set_mode("wake")
    ev = s.feed(frames(10, SPEECH) + frames(50, SILENCE))
    assert types(ev) == ["wake_rejected"]
    assert s.mode == "wake"


def test_wake_closed_by_vad_when_vosk_never_endpoints():
    rec = FakeRecognizer(_wake_result("a ra one", 0.9))  # never endpoints on its own
    s = STTSession(FakeEngine(wake=rec), vad=energy_vad)
    s.set_mode("wake")
    ev = s.feed(frames(30, SPEECH) + frames(30, SILENCE))
    wake = [e for e in ev if e["type"] == "wake"]
    assert wake and wake[0]["remainder"] == "" and wake[0]["verified_by"] == "vosk"


def test_non_wake_utterance_ignored():
    rec = FakeRecognizer({"text": "[unk]", "result": []}, after_frames=10)
    engine = FakeEngine(wake=rec)
    s = STTSession(engine, vad=energy_vad)
    s.set_mode("wake")
    assert s.feed(frames(10, SPEECH)) == []
    assert engine.transcribed == []


def test_wake_grammar_covers_aliases():
    g = build_wake_grammar()
    assert "hey raw one" in g and "ra one" in g and g[-1] == "[unk]"


# ── API surface (no models needed) ────────────────────────────────
def test_stt_status(client):
    r = client.get("/api/stt/status")
    assert r.status_code == 200
    data = r.json()
    assert data["offline"] is True
    assert data["engine"] == "vosk+faster-whisper"


# ── integration: real models + Piper-generated speech ─────────────
ENGINE = get_stt_engine()


def _piper_ready() -> bool:
    try:
        from app.voice.OfflineTTSEngine import get_tts_engine

        return any(v["id"] == "en_US-joe-medium" for v in get_tts_engine().list_installed_voices())
    except Exception:
        return False


needs_models = pytest.mark.skipif(
    not (ENGINE.available and _piper_ready()), reason="STT or Piper models not downloaded"
)


def speak_pcm16k(text: str, lead_s: float = 0.5, tail_s: float = 1.5) -> bytes:
    from scipy.signal import resample_poly

    from app.voice.OfflineTTSEngine import get_tts_engine

    voice = get_tts_engine().get_voice("en_US-joe-medium")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        voice.synthesize_wav(text, wf)
    buf.seek(0)
    with wave.open(buf) as wf:
        sr = wf.getframerate()
        pcm = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
    pcm = resample_poly(pcm.astype(np.float32), SAMPLE_RATE, sr).clip(-32768, 32767).astype(np.int16)
    lead = np.zeros(int(SAMPLE_RATE * lead_s), dtype=np.int16)
    tail = np.zeros(int(SAMPLE_RATE * tail_s), dtype=np.int16)
    return np.concatenate([lead, pcm, tail]).tobytes()


def pcm_to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    return buf.getvalue()


@needs_models
def test_whisper_transcribes_question():
    ENGINE.preload()
    pcm = speak_pcm16k("What is the weather like today?")
    result = ENGINE.transcribe(pcm)
    assert "weather" in result.text.lower()


@needs_models
def test_whisper_latency_budget():
    ENGINE.preload()
    pcm = speak_pcm16k("Open the browser please.", tail_s=0.3)
    t = time.perf_counter()
    ENGINE.transcribe(pcm)
    elapsed = time.perf_counter() - t
    # i7-8650U, base.en int8: ~1.6 s observed. Fail only on a real regression.
    assert elapsed < 4.0, f"transcription took {elapsed:.2f}s"


@needs_models
def test_real_wake_with_question_remainder():
    s = STTSession(ENGINE)
    s.set_mode("wake")
    ev = s.feed(speak_pcm16k("Hey Raw-One, what time is it?"))
    wake = [e for e in ev if e["type"] == "wake"]
    assert wake, ev
    assert "time" in wake[0]["remainder"]


@needs_models
def test_real_bare_wake():
    s = STTSession(ENGINE)
    s.set_mode("wake")
    ev = s.feed(speak_pcm16k("Hey Raw-One."))
    wake = [e for e in ev if e["type"] == "wake"]
    assert wake, ev
    assert wake[0]["remainder"] == ""


@needs_models
@pytest.mark.parametrize("phrase", ["The weather is nice today.", "Open the browser please."])
def test_real_non_wake_speech_does_not_wake(phrase):
    s = STTSession(ENGINE)
    s.set_mode("wake")
    ev = s.feed(speak_pcm16k(phrase))
    assert not [e for e in ev if e["type"] == "wake"]


@needs_models
def test_real_question_mode_end_to_end():
    s = STTSession(ENGINE)
    s.set_mode("question")
    ev = s.feed(speak_pcm16k("Tell me a joke about robots."))
    final = [e for e in ev if e["type"] == "final"]
    assert final, ev
    assert "joke" in final[0]["text"].lower()


@needs_models
def test_transcribe_endpoint_accepts_wav(client):
    wav = pcm_to_wav(speak_pcm16k("Set a timer for five minutes."))
    r = client.post("/api/stt/transcribe", content=wav, headers={"Content-Type": "audio/wav"})
    assert r.status_code == 200, r.text
    assert "timer" in r.json()["text"].lower()


@needs_models
def test_websocket_streams_wake_then_question(client):
    chunk = FRAME_BYTES  # 20 ms, like the AudioWorklet will send
    with client.websocket_connect("/ws/stt") as ws:
        assert ws.receive_json()["type"] == "ready"

        ws.send_text(json.dumps({"cmd": "mode", "value": "wake", "seq": 1}))
        assert ws.receive_json() == {"type": "mode", "mode": "wake", "seq": 1}
        audio = speak_pcm16k("Hey Raw-One.")
        for i in range(0, len(audio), chunk):
            ws.send_bytes(audio[i : i + chunk])
        wake = _receive_until(ws, "wake")
        assert wake["remainder"] == "" and wake["seq"] == 1

        # Server drops to "off" after a wake so RA-ONE's spoken ack is never transcribed
        assert _receive_until(ws, "mode")["mode"] == "off"

        ws.send_text(json.dumps({"cmd": "mode", "value": "question", "seq": 2}))
        assert _receive_until(ws, "mode") == {"type": "mode", "mode": "question", "seq": 2}
        audio = speak_pcm16k("What is the capital of France?")
        for i in range(0, len(audio), chunk):
            ws.send_bytes(audio[i : i + chunk])
        final = _receive_until(ws, "final")
        assert "france" in final["text"].lower() and final["seq"] == 2


def _receive_until(ws, event_type: str, limit: int = 500) -> dict:
    for _ in range(limit):
        ev = ws.receive_json()
        if ev["type"] == event_type:
            return ev
        assert ev["type"] != "error", ev
    raise AssertionError(f"no {event_type} event")
