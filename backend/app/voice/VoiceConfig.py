"""Paths and limits for the offline Piper voice engine."""

from __future__ import annotations

from pathlib import Path

from app.core.paths import MODELS_ROOT

MODELS_DIR = MODELS_ROOT / "piper"
PRESETS_PATH = Path(__file__).resolve().parent / "presets.json"
VOICE_SETTINGS_PATH = Path(__file__).resolve().parent / "voice_settings.json"

# Voices to install via `python -m piper.download_voices` (male cinematic candidates)
DEFAULT_VOICE_IDS = (
    "en_US-bryce-medium",
    "en_US-joe-medium",
    "en_GB-alan-medium",
)

DEFAULT_VOICE_ID = "en_US-bryce-medium"
MAX_TEXT_CHARS = 800
DEFAULT_PRESET = "raone_jarvis"

# Soft peak target after processing (linear)
NORMALIZE_PEAK = 0.92
