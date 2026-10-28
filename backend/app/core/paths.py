"""Filesystem roots shared by TTS/STT (overridable for the packaged desktop build)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

# PyInstaller sets sys.frozen; modules then live in _internal/, so anchor on the exe instead
FROZEN = bool(getattr(sys, "frozen", False))

# backend/ when running from source; the folder holding raone-backend.exe when packaged
BACKEND_ROOT = Path(sys.executable).parent if FROZEN else Path(__file__).resolve().parents[2]

# RAONE_MODELS_DIR lets the desktop installer keep models outside the exe bundle
MODELS_ROOT = Path(os.environ.get("RAONE_MODELS_DIR") or (BACKEND_ROOT / "models")).resolve()

# Built frontend (vite `dist/`) to serve at "/" so UI and API are same-origin; unset = API only
_static = os.environ.get("RAONE_STATIC_DIR", "").strip()
STATIC_DIR = Path(_static).resolve() if _static else None


def raone_home() -> Path:
    """Persistent RA-ONE data root under the user profile (not Program Files)."""
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local) / "RAONE"


# Log files; RAONE_LOG_DIR overrides. Only used when file logging is on (see core/logging.py)
LOG_DIR = Path(os.environ.get("RAONE_LOG_DIR") or (raone_home() / "logs")).resolve()
