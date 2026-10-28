"""Module 4 (desktop build): same-origin UI serving, frozen paths, file logging."""

from __future__ import annotations

import importlib
import logging
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import create_app


def _web_dir(tmp_path: Path) -> Path:
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>RA-ONE</title>", encoding="utf-8")
    (web / "assets" / "app.js").write_text("console.log('ra')", encoding="utf-8")
    return web


def test_static_ui_served_alongside_api(settings_dev, tmp_path):
    with TestClient(create_app(settings_dev, static_dir=_web_dir(tmp_path))) as client:
        root = client.get("/")
        assert root.status_code == 200
        assert "RA-ONE" in root.text
        assert client.get("/assets/app.js").status_code == 200
        # API routes are registered first and still win over the "/" mount
        assert client.get("/api/health").json()["status"] == "ok"
        with client.websocket_connect("/ws/assistant") as ws:
            assert ws.receive_json()["type"] == "assistant.state"


def test_no_static_dir_means_api_only(settings_dev):
    with TestClient(create_app(settings_dev, static_dir=None)) as client:
        assert client.get("/").status_code == 404
        assert client.get("/api/health").status_code == 200


def test_static_dir_without_index_is_ignored(settings_dev, tmp_path):
    with TestClient(create_app(settings_dev, static_dir=tmp_path)) as client:
        assert client.get("/").status_code == 404


def test_frozen_paths_anchor_on_exe(monkeypatch, tmp_path):
    import app.core.paths as paths

    exe = tmp_path / "raone-backend" / "raone-backend.exe"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(exe))
    monkeypatch.delenv("RAONE_MODELS_DIR", raising=False)
    monkeypatch.setenv("RAONE_STATIC_DIR", str(tmp_path / "web"))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "appdata"))
    monkeypatch.delenv("RAONE_LOG_DIR", raising=False)
    try:
        importlib.reload(paths)
        assert paths.FROZEN is True
        assert paths.MODELS_ROOT == (exe.parent / "models").resolve()
        assert paths.STATIC_DIR == (tmp_path / "web").resolve()
        assert paths.LOG_DIR == (tmp_path / "appdata" / "RAONE" / "logs").resolve()
    finally:
        monkeypatch.undo()
        importlib.reload(paths)


def test_file_logging_writes_backend_log(tmp_path, monkeypatch):
    from app.core import logging as raone_logging

    root = logging.getLogger()
    saved = root.handlers[:]
    root.handlers = []
    monkeypatch.setattr(sys, "stdout", None)  # --noconsole
    try:
        raone_logging.configure_logging("INFO", log_dir=tmp_path / "logs")
        logging.getLogger("raone.test").info("hello from the tray")
        for h in root.handlers:
            h.flush()
        text = (tmp_path / "logs" / "backend.log").read_text(encoding="utf-8")
        assert "hello from the tray" in text
        assert not any(isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler)
                       for h in root.handlers)
    finally:
        for h in root.handlers:
            h.close()
        root.handlers = saved
