#!/usr/bin/env python3
"""Download Piper ONNX voices into backend/models/piper (install-time only)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models" / "piper"
VOICES = (
    "en_US-bryce-medium",
    "en_US-joe-medium",
    "en_GB-alan-medium",
)


def main() -> int:
    MODELS.mkdir(parents=True, exist_ok=True)
    print(f"Models directory: {MODELS}")
    try:
        import importlib.metadata as md

        print(f"piper-tts version: {md.version('piper-tts')}")
    except Exception as exc:
        print("piper-tts is not installed:", exc)
        return 1

    # Piper 1.8 download_voices writes into CWD by default; run from models dir
    failed = []
    for voice in VOICES:
        onnx = MODELS / f"{voice}.onnx"
        if onnx.exists():
            print(f"[skip] {voice} already present")
            continue
        print(f"[download] {voice} ...")
        cmd = [
            sys.executable,
            "-m",
            "piper.download_voices",
            voice,
            "--download-dir",
            str(MODELS),
        ]
        # Older CLIs used --data-dir; try both
        proc = subprocess.run(cmd, cwd=str(MODELS), capture_output=True, text=True)
        if proc.returncode != 0:
            cmd2 = [
                sys.executable,
                "-m",
                "piper.download_voices",
                voice,
                "--data-dir",
                str(MODELS),
            ]
            proc = subprocess.run(cmd2, cwd=str(MODELS), capture_output=True, text=True)
        if proc.returncode != 0:
            # Last resort: no flags, cwd = models
            proc = subprocess.run(
                [sys.executable, "-m", "piper.download_voices", voice],
                cwd=str(MODELS),
                capture_output=True,
                text=True,
            )
        if proc.returncode != 0:
            print(proc.stdout)
            print(proc.stderr)
            failed.append(voice)
        else:
            print(f"[ok] {voice}")
            if proc.stdout.strip():
                print(proc.stdout.strip()[:500])

    print("Installed:")
    for p in sorted(MODELS.glob("*.onnx")):
        print(" ", p.name)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
