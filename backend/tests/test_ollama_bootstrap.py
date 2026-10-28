"""Ollama bootstrap — install when missing, then start (never pulls models)."""

from __future__ import annotations

from pathlib import Path

from app.llm.ollama_bootstrap import ensure_ollama

EXE = Path(r"C:\Users\x\AppData\Local\Programs\Ollama\ollama.exe")
URL = "http://127.0.0.1:11434"


def test_already_installed_just_starts():
    started = []
    installs = []
    status = ensure_ollama(
        URL,
        find=lambda: EXE,
        installers=(lambda: installs.append(1) or True,),
        start=lambda exe, url: started.append((exe, url)) or True,
        platform="win32",
    )
    assert status["state"] == "started"
    assert installs == []
    assert started == [(EXE, URL)]


def test_missing_installs_then_starts():
    found = iter([None, EXE])
    status = ensure_ollama(
        URL,
        find=lambda: next(found),
        installers=(lambda: True,),
        start=lambda exe, url: True,
        platform="win32",
    )
    assert status["state"] == "started"


def test_falls_back_to_second_installer():
    found = iter([None, EXE])
    calls = []
    status = ensure_ollama(
        URL,
        find=lambda: next(found),
        installers=(lambda: calls.append("winget") and False, lambda: calls.append("setup") or True),
        start=lambda exe, url: True,
        platform="win32",
    )
    assert calls == ["winget", "setup"]
    assert status["state"] == "started"


def test_all_installers_fail():
    started = []
    status = ensure_ollama(
        URL,
        find=lambda: None,
        installers=(lambda: False, lambda: False),
        start=lambda exe, url: started.append(exe) or True,
        platform="win32",
    )
    assert status["state"] == "failed"
    assert started == []


def test_non_windows_does_nothing():
    status = ensure_ollama(
        URL,
        find=lambda: None,
        installers=(),
        start=lambda exe, url: True,
        platform="linux",
    )
    assert status["state"] == "unsupported"
