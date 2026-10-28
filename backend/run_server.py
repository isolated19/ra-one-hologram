"""
RA-ONE backend entry point for the desktop build (also the PyInstaller target).

  python run_server.py                      # from source
  raone-backend.exe                         # packaged (scripts/build_backend.ps1)

Env: PORT (8000), RAONE_HOST (127.0.0.1 — never exposed to the LAN), RAONE_MODELS_DIR,
RAONE_STATIC_DIR (built frontend to serve at "/"), RAONE_LOG_DIR (%LOCALAPPDATA%\\RAONE\\logs),
RAONE_PARENT_PID (exit when that process dies — set by the Electron shell).
"""

from __future__ import annotations

import multiprocessing
import os
import sys


def _exit_with_parent(pid: int, logger) -> None:
    """Exit when the desktop shell dies (crash / Task Manager), so no orphan holds the port."""
    if sys.platform != "win32":
        return
    import ctypes
    import threading

    synchronize, infinite = 0x00100000, 0xFFFFFFFF
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        logger.warning("RAONE_PARENT_PID=%s not found; not watching parent", pid)
        return

    def wait() -> None:
        kernel32.WaitForSingleObject(handle, infinite)
        logger.info("Parent process %s exited — shutting down backend", pid)
        os._exit(0)

    threading.Thread(target=wait, name="raone-parent-watch", daemon=True).start()


def main() -> None:
    from app.core.logging import configure_logging, get_logger
    from app.core.paths import FROZEN, LOG_DIR, MODELS_ROOT, STATIC_DIR

    configure_logging(os.environ.get("LOG_LEVEL", "INFO"), log_dir=LOG_DIR)
    if sys.stdout is None:
        # --noconsole: give stray prints somewhere to go and keep crash tracebacks
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
        sys.stderr = open(LOG_DIR / "stderr.log", "a", encoding="utf-8", buffering=1)

    logger = get_logger("raone.server")
    host = os.environ.get("RAONE_HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    logger.info(
        "run_server: frozen=%s host=%s port=%s models=%s static=%s logs=%s",
        FROZEN, host, port, MODELS_ROOT, STATIC_DIR, LOG_DIR,
    )
    parent = os.environ.get("RAONE_PARENT_PID", "").strip()
    if parent.isdigit():
        _exit_with_parent(int(parent), logger)

    import uvicorn

    from app.main import app

    # log_config=None: uvicorn's loggers propagate to our root handlers (console + file)
    uvicorn.run(app, host=host, port=port, log_config=None, access_log=False)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
