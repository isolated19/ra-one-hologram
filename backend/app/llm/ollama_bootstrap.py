"""
Install and start Ollama on its own when it is missing (Windows).

Runs from the boot task before wait_for_ollama:
1. Find ollama.exe (PATH, then the default install folders).
2. Missing → silent install via winget, else the official OllamaSetup.exe.
3. Installed but not answering → start `ollama serve` hidden, bound to loopback.

Models are pulled separately by the boot task (OLLAMA_AUTO_PULL), reported here as "pulling-model".
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

from app.core.logging import get_logger

logger = get_logger(__name__)

INSTALLER_URL = "https://ollama.com/download/OllamaSetup.exe"
WINGET_ID = "Ollama.Ollama"
INSTALL_TIMEOUT_SEC = 20 * 60

# Shared with /api/llm/health so the UI can say "installing" instead of "offline"
_status: dict[str, str] = {"state": "unknown", "detail": ""}


def bootstrap_status() -> dict[str, str]:
    return dict(_status)


def set_status(state: str, detail: str = "") -> None:
    _status["state"] = state
    _status["detail"] = detail
    log = logger.warning if state == "failed" else logger.info
    log("Ollama bootstrap: %s%s", state, f" — {detail}" if detail else "")


def _no_window() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def find_ollama_exe() -> Path | None:
    on_path = shutil.which("ollama")
    if on_path:
        return Path(on_path)
    candidates = []
    for env in ("LOCALAPPDATA", "ProgramFiles"):
        base = os.environ.get(env)
        if base:
            candidates.append(Path(base) / "Programs" / "Ollama" / "ollama.exe")
            candidates.append(Path(base) / "Ollama" / "ollama.exe")
    for path in candidates:
        if path.is_file():
            return path
    return None


def install_via_winget() -> bool:
    winget = shutil.which("winget")
    if not winget:
        logger.info("winget not available — falling back to the Ollama installer")
        return False
    cmd = [
        winget, "install", "--id", WINGET_ID, "-e", "--silent",
        "--accept-package-agreements", "--accept-source-agreements",
        "--disable-interactivity",
    ]
    try:
        r = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=INSTALL_TIMEOUT_SEC,
            creationflags=_no_window(),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("winget install of Ollama failed: %s", exc)
        return False
    if r.returncode != 0:
        logger.warning("winget install of Ollama exited %s: %s", r.returncode, (r.stdout or r.stderr)[-500:])
        return False
    return True


def install_via_installer() -> bool:
    target = Path(tempfile.mkdtemp(prefix="raone-ollama-")) / "OllamaSetup.exe"
    try:
        with httpx.stream("GET", INSTALLER_URL, follow_redirects=True, timeout=60.0) as resp:
            resp.raise_for_status()
            with target.open("wb") as fh:
                for chunk in resp.iter_bytes():
                    fh.write(chunk)
    except (httpx.HTTPError, OSError) as exc:
        logger.warning("Ollama installer download failed: %s", exc)
        return False
    try:
        # Inno Setup flags: no UI, no reboot, no prompts
        r = subprocess.run(
            [str(target), "/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES", "/SP-"],
            timeout=INSTALL_TIMEOUT_SEC,
            creationflags=_no_window(),
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.warning("Ollama installer failed to run: %s", exc)
        return False
    finally:
        try:
            target.unlink(missing_ok=True)
            target.parent.rmdir()
        except OSError:
            pass
    if r.returncode != 0:
        logger.warning("Ollama installer exited %s", r.returncode)
        return False
    return True


def start_ollama_serve(exe: Path, base_url: str) -> bool:
    parsed = urlparse(base_url)
    env = dict(os.environ)
    # Keep the API on loopback only, same as LocalLLMService enforces
    env["OLLAMA_HOST"] = f"{parsed.hostname or '127.0.0.1'}:{parsed.port or 11434}"
    try:
        subprocess.Popen(
            [str(exe), "serve"],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_no_window() | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            close_fds=True,
        )
    except OSError as exc:
        logger.warning("Could not start `ollama serve`: %s", exc)
        return False
    return True


def ensure_ollama(
    base_url: str,
    *,
    find: Callable[[], Path | None] = find_ollama_exe,
    installers: tuple[Callable[[], bool], ...] = (install_via_winget, install_via_installer),
    start: Callable[[Path, str], bool] = start_ollama_serve,
    platform: str = sys.platform,
) -> dict[str, Any]:
    """
    Blocking — call via asyncio.to_thread. Installs Ollama if missing, then starts it.

    Only call when the API is already known to be unreachable.
    """
    if platform != "win32":
        set_status("unsupported", "Auto-install is Windows-only — install Ollama manually")
        return bootstrap_status()

    set_status("checking")
    exe = find()
    if exe is None:
        set_status("installing", "Ollama not found — installing silently")
        for install in installers:
            if install():
                exe = find()
                if exe is not None:
                    break
        if exe is None:
            set_status(
                "failed",
                "Automatic install failed — install from https://ollama.com/download/windows",
            )
            return bootstrap_status()
        logger.info("Ollama installed at %s", exe)

    set_status("starting", str(exe))
    if not start(exe, base_url):
        set_status("failed", f"Ollama installed at {exe} but could not be started")
        return bootstrap_status()
    set_status("started", str(exe))
    return bootstrap_status()
