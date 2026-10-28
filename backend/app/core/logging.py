"""Structured logging setup for the RA-ONE backend."""

from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler

FORMAT = "%(asctime)s | %(levelname)-7s | %(name)s | %(message)s"
DATEFMT = "%Y-%m-%dT%H:%M:%S"
LOG_FILE_NAME = "backend.log"


def configure_logging(level: str = "INFO", *, log_dir=None) -> None:
    """Console logging; plus a rotating file in `log_dir` (the packaged app has no console)."""
    root = logging.getLogger()
    if root.handlers:
        root.setLevel(level.upper())
        return

    formatter = logging.Formatter(fmt=FORMAT, datefmt=DATEFMT)
    # --noconsole builds have no stdout at all
    if sys.stdout is not None:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(formatter)
        root.addHandler(handler)
    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            log_dir / LOG_FILE_NAME, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8"
        )
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
    root.setLevel(level.upper())

    # Quiet noisy third-party loggers in development
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
