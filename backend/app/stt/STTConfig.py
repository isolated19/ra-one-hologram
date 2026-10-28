"""Paths and tuning for offline speech-to-text (Vosk wake gate + faster-whisper)."""

from __future__ import annotations

import os

from app.core.paths import MODELS_ROOT

SAMPLE_RATE = 16000
# webrtcvad accepts 10/20/30 ms frames; 20 ms keeps latency low on the i7-8650U
FRAME_MS = 20
FRAME_BYTES = SAMPLE_RATE * FRAME_MS // 1000 * 2  # PCM16 mono

VOSK_MODEL_NAME = "vosk-model-small-en-us-0.15"
VOSK_MODEL_URL = f"https://alphacephei.com/vosk/models/{VOSK_MODEL_NAME}.zip"
VOSK_MODEL_DIR = MODELS_ROOT / "vosk" / VOSK_MODEL_NAME

WHISPER_MODEL_SIZE = os.environ.get("RAONE_WHISPER_MODEL", "base.en")
WHISPER_MODEL_DIR = MODELS_ROOT / "whisper" / WHISPER_MODEL_SIZE
WHISPER_COMPUTE_TYPE = "int8"
WHISPER_THREADS = int(os.environ.get("RAONE_WHISPER_THREADS", "4"))
# Biases decoding toward the assistant's name instead of "Ra.One" / "Rowan"
WHISPER_INITIAL_PROMPT = "Hey RA-ONE."

# Question capture (mirrors frontend SpeechRecognitionService defaults)
QUESTION_GRACE_MS = 5000      # wait this long for the user to start talking
QUESTION_SILENCE_MS = 900     # end of speech after this much silence
QUESTION_MAX_MS = 9000        # hard cap per question; background noise used to hold every capture open 12 s
VAD_AGGRESSIVENESS = 2        # 0 (lenient) … 3 (strict)
MIN_SPEECH_MS = 240           # shorter blips are treated as noise

# Wake utterances longer than this are kept in memory for remainder transcription
WAKE_BUFFER_MAX_MS = 10000
# Silence after speech that closes a wake utterance (Vosk's own endpointing is slower)
WAKE_ENDPOINT_MS = 500
# Vosk word confidence needed to accept a bare wake when whisper disagrees
WAKE_MIN_CONFIDENCE = 0.75
