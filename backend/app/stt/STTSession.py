"""
Per-connection STT state machine fed with 16 kHz PCM16 mono audio.

Modes (client-controlled; the server drops to "off" after wake/final so RA-ONE's own
speech is never transcribed):
  off       audio is discarded
  wake      Vosk grammar listens for "Hey RA-ONE"; whisper recovers any trailing question
  question  VAD segments one utterance; whisper produces the final text

Timeouts are counted in audio frames, not wall-clock time, so behaviour is deterministic
for tests and matches what the user actually said.
"""

from __future__ import annotations

import json
from collections import deque
from typing import Any, Callable

from app.assistant.name_normalizer import match_wake_phrase
from app.core.logging import get_logger

from .STTConfig import (
    FRAME_BYTES,
    FRAME_MS,
    MIN_SPEECH_MS,
    QUESTION_GRACE_MS,
    QUESTION_MAX_MS,
    QUESTION_SILENCE_MS,
    SAMPLE_RATE,
    VAD_AGGRESSIVENESS,
    WAKE_BUFFER_MAX_MS,
    WAKE_ENDPOINT_MS,
    WAKE_MIN_CONFIDENCE,
)

logger = get_logger(__name__)

MODES = ("off", "wake", "question")
Event = dict[str, Any]

# Frames of consecutive voice needed to call it speech, and pre-roll kept before that
_SPEECH_START_FRAMES = 3
_PREROLL_FRAMES = 15  # 300 ms so the first syllable is not clipped
# Vosk grammar output sometimes starts with a stray filler ("a ra one")
_MAX_LEADING_FILLER = 3


def default_vad() -> Callable[[bytes], bool]:
    import webrtcvad

    vad = webrtcvad.Vad(VAD_AGGRESSIVENESS)
    return lambda frame: vad.is_speech(frame, SAMPLE_RATE)


class STTSession:
    def __init__(self, engine: Any, *, vad: Callable[[bytes], bool] | None = None) -> None:
        self.engine = engine
        self.vad = vad or default_vad()
        self.mode = "off"
        # Client-chosen id of the current mode request; echoed on events so stale ones can be dropped
        self.seq: int | None = None
        self._pending = b""
        self._wake_rec: Any = None
        self._wake_frames: deque[bytes] = deque(maxlen=WAKE_BUFFER_MAX_MS // FRAME_MS)
        self._last_partial = ""
        self._reset_question()

    # ── control ───────────────────────────────────────────────────
    def set_mode(
        self,
        mode: str,
        *,
        grace_ms: int | None = None,
        silence_ms: int | None = None,
        max_ms: int | None = None,
        seq: int | None = None,
    ) -> list[Event]:
        if mode not in MODES:
            return [{"type": "error", "error": "bad-mode", "message": f"Unknown mode {mode!r}"}]
        self.mode = mode
        self.seq = seq
        self._pending = b""
        self._last_partial = ""
        if mode == "wake":
            self._wake_rec = self.engine.new_wake_recognizer()
            self._reset_wake_buffer()
        elif mode == "question":
            self._reset_question(grace_ms=grace_ms, silence_ms=silence_ms, max_ms=max_ms)
            self._partial_rec = self.engine.new_partial_recognizer()
        return [{"type": "mode", "mode": mode}]

    def feed(self, chunk: bytes) -> list[Event]:
        """Accept any-sized PCM16 chunk; returns events produced by complete frames."""
        if self.mode == "off":
            return []
        self._pending += chunk
        events: list[Event] = []
        while len(self._pending) >= FRAME_BYTES and self.mode != "off":
            frame, self._pending = self._pending[:FRAME_BYTES], self._pending[FRAME_BYTES:]
            if self.mode == "wake":
                events += self._wake_frame(frame)
            else:
                events += self._question_frame(frame)
        if self.mode == "off":
            self._pending = b""
        return events

    # ── wake mode ─────────────────────────────────────────────────
    def _reset_wake_buffer(self) -> None:
        self._wake_frames.clear()
        self._wake_heard_voice = False
        self._wake_silence_run = 0
        self._wake_tail: dict | None = None
        self._last_partial = ""

    def _wake_frame(self, frame: bytes) -> list[Event]:
        self._wake_frames.append(frame)
        if self.vad(frame):
            self._wake_heard_voice = True
            self._wake_silence_run = 0
        else:
            self._wake_silence_run += 1

        if self._wake_tail is not None:
            # Wake heard with more speech after it: record until the speaker pauses like a
            # question ends (Vosk's grammar endpointing fires mid-sentence and would cut it)
            full = len(self._wake_frames) == self._wake_frames.maxlen
            if full or self._wake_silence_run >= QUESTION_SILENCE_MS // FRAME_MS:
                return self._verify_wake_tail()
            return []

        if self._wake_rec.AcceptWaveform(frame):
            return self._wake_utterance_end(json.loads(self._wake_rec.Result()))

        # Vosk's own endpointing can lag on grammar decoding; close the utterance ourselves
        if self._wake_heard_voice and self._wake_silence_run >= WAKE_ENDPOINT_MS // FRAME_MS:
            return self._wake_utterance_end(json.loads(self._wake_rec.FinalResult()))

        if not self._wake_heard_voice:
            # Keep only a short pre-roll while the room is quiet
            while len(self._wake_frames) > _PREROLL_FRAMES:
                self._wake_frames.popleft()
        text = json.loads(self._wake_rec.PartialResult()).get("partial", "")
        text = text.replace("[unk]", "").strip()
        if text and text != self._last_partial:
            self._last_partial = text
            return [{"type": "partial", "mode": "wake", "text": text}]
        return []

    @staticmethod
    def _match_vosk_wake(heard: str) -> dict:
        tokens = heard.split()
        for skip in range(min(_MAX_LEADING_FILLER, len(tokens)) + 1):
            hit = match_wake_phrase(" ".join(tokens[skip:]))
            if hit["matched"]:
                return hit
        return {"matched": False}

    def _wake_utterance_end(self, result: dict) -> list[Event]:
        words = result.get("result", [])
        raw = result.get("text", "")
        heard = raw.replace("[unk]", " ").strip()
        hit = self._match_vosk_wake(heard)
        if not hit["matched"]:
            self._reset_wake_buffer()
            return []

        known = [w for w in words if w.get("word") != "[unk]"]
        confidence = sum(w.get("conf", 0.0) for w in known) / max(1, len(known))
        trailing = "[unk]" in raw or bool(hit["remainder"])

        # Fast path: a clean, confident bare wake needs no whisper round-trip
        if not trailing and confidence >= WAKE_MIN_CONFIDENCE:
            self._reset_wake_buffer()
            return self._emit_wake(heard, "", hit["greeting"], confidence, "vosk")

        self._wake_tail = {"raw": raw, "heard": heard, "greeting": hit["greeting"], "confidence": confidence}
        if self._wake_silence_run >= QUESTION_SILENCE_MS // FRAME_MS:
            return self._verify_wake_tail()
        return []

    def _verify_wake_tail(self) -> list[Event]:
        tail = self._wake_tail
        utterance = b"".join(self._wake_frames)
        self._reset_wake_buffer()
        self._wake_rec = self.engine.new_wake_recognizer()  # drop Vosk state from the tail audio
        raw, heard, confidence = tail["raw"], tail["heard"], tail["confidence"]
        try:
            verified = self.engine.transcribe(utterance)
        except Exception as exc:
            logger.warning("Wake verification failed: %s", exc)
            return [{"type": "error", "error": "transcribe-failed", "message": str(exc)}]

        whisper_hit = match_wake_phrase(verified.text)
        if whisper_hit["matched"]:
            return self._emit_wake(
                verified.text, whisper_hit["remainder"], whisper_hit["greeting"], confidence, "whisper"
            )
        if confidence >= WAKE_MIN_CONFIDENCE:
            # Vosk was sure but whisper spelled the name oddly — wake without a remainder
            return self._emit_wake(heard, "", tail["greeting"], confidence, "vosk")
        logger.info("STT wake rejected: vosk=%r whisper=%r conf=%.2f", raw, verified.text, confidence)
        return [{"type": "wake_rejected", "vosk": raw, "whisper": verified.text}]

    def _emit_wake(
        self, transcript: str, remainder: str, greeting: str | None, confidence: float, verified_by: str
    ) -> list[Event]:
        logger.info(
            "STT wake (%s, conf=%.2f) transcript=%r remainder=%r", verified_by, confidence, transcript, remainder
        )
        self.mode = "off"
        return [
            {
                "type": "wake",
                "transcript": transcript,
                "remainder": remainder,
                "greeting": greeting,
                "confidence": round(confidence, 3),
                "verified_by": verified_by,
            },
            {"type": "mode", "mode": "off"},
        ]

    # ── question mode ─────────────────────────────────────────────
    def _reset_question(
        self, *, grace_ms: int | None = None, silence_ms: int | None = None, max_ms: int | None = None
    ) -> None:
        self._grace_frames = (grace_ms or QUESTION_GRACE_MS) // FRAME_MS
        self._silence_frames = (silence_ms or QUESTION_SILENCE_MS) // FRAME_MS
        self._max_frames = (max_ms or QUESTION_MAX_MS) // FRAME_MS
        self._min_speech_frames = MIN_SPEECH_MS // FRAME_MS
        self._elapsed = 0
        self._voiced_run = 0
        self._voiced_total = 0
        self._silence_run = 0
        self._speaking = False
        self._preroll: deque[bytes] = deque(maxlen=_PREROLL_FRAMES)
        self._segment: list[bytes] = []
        self._partial_rec: Any = None

    def _question_frame(self, frame: bytes) -> list[Event]:
        events: list[Event] = []
        self._elapsed += 1
        voiced = self.vad(frame)

        if not self._speaking:
            self._preroll.append(frame)
            self._voiced_run = self._voiced_run + 1 if voiced else 0
            if self._voiced_run >= _SPEECH_START_FRAMES:
                self._speaking = True
                self._segment = list(self._preroll)
                self._voiced_total = self._voiced_run
                self._silence_run = 0
                for f in self._segment:
                    self._partial_rec.AcceptWaveform(f)
                events.append({"type": "speech_start"})
            elif self._elapsed >= self._grace_frames:
                return self._finish_empty("no-speech")
            elif self._elapsed >= self._max_frames:
                return self._finish_empty("timeout")
            return events

        self._segment.append(frame)
        if voiced:
            self._voiced_total += 1
            self._silence_run = 0
        else:
            self._silence_run += 1
        events += self._partial(frame)

        if self._silence_run >= self._silence_frames:
            if self._voiced_total < self._min_speech_frames:
                # A cough or click — keep waiting for real speech within the grace window
                self._speaking = False
                self._voiced_run = 0
                self._preroll.clear()
                self._partial_rec = self.engine.new_partial_recognizer()
                if self._elapsed >= self._grace_frames:
                    return events + self._finish_empty("noise")
                return events
            return events + self._finish_final("silence")
        if self._elapsed >= self._max_frames:
            return events + self._finish_final("timeout")
        return events

    def _partial(self, frame: bytes) -> list[Event]:
        rec = self._partial_rec
        if rec.AcceptWaveform(frame):
            text = json.loads(rec.Result()).get("text", "")
        else:
            text = json.loads(rec.PartialResult()).get("partial", "")
        text = text.strip()
        if text and text != self._last_partial:
            self._last_partial = text
            return [{"type": "partial", "mode": "question", "text": text}]
        return []

    def _finish_empty(self, reason: str) -> list[Event]:
        self.mode = "off"
        return [{"type": "empty", "reason": reason}, {"type": "mode", "mode": "off"}]

    def _finish_final(self, reason: str) -> list[Event]:
        audio = b"".join(self._segment)
        self.mode = "off"
        try:
            result = self.engine.transcribe(audio)
        except Exception as exc:
            logger.warning("Question transcription failed: %s", exc)
            return [
                {"type": "error", "error": "transcribe-failed", "message": str(exc)},
                {"type": "mode", "mode": "off"},
            ]
        logger.info(
            "STT final (%s) %.1fs audio in %.0f ms: %r", reason, result.audio_sec, result.latency_ms, result.text
        )
        if not result.text:
            return [{"type": "empty", "reason": "unintelligible"}, {"type": "mode", "mode": "off"}]
        return [
            {
                "type": "final",
                "text": result.text,
                "reason": reason,
                "latency_ms": round(result.latency_ms, 1),
                "audio_sec": round(result.audio_sec, 2),
            },
            {"type": "mode", "mode": "off"},
        ]
