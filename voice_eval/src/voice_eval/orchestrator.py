"""Spawn engine workers in dedicated venvs; apply rugged FX; collect metrics."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import yaml

from voice_eval.pronunciation import DISPLAY_NAME, SPOKEN_NAME, to_spoken_text
from voice_eval.reference_validator import validate_reference
from voice_eval.rugged_fx import PRESETS, apply_fx

ROOT = Path(__file__).resolve().parents[2]


def load_config() -> dict:
    cfg_path = ROOT / "config.yaml"
    with open(cfg_path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def venv_python(name: str) -> Path:
    return ROOT / "venvs" / name / "Scripts" / "python.exe"


def worker_script(engine: str) -> Path:
    return ROOT / "src" / "voice_eval" / "engines" / f"{engine}_worker.py"


ENGINES = {
    "pocket": {"venv": "pocket", "worker": "pocket", "supports_clone": True},
    "coqui": {"venv": "coqui", "worker": "coqui", "supports_clone": True},
    "kokoro": {"venv": "kokoro", "worker": "kokoro", "supports_clone": False},
}


def engine_status() -> list[dict]:
    rows = []
    for key, meta in ENGINES.items():
        py = venv_python(meta["venv"])
        rows.append(
            {
                "id": key,
                "venv_ready": py.exists(),
                "supports_clone": meta["supports_clone"],
                "python": str(py) if py.exists() else None,
            }
        )
    return rows


def run_engine(
    engine: str,
    *,
    text: str | None = None,
    reference_wav: str | None = None,
    preset: str = "none",
    voice: str | None = None,
    mode: str | None = None,
    timeout_sec: float = 900.0,
) -> dict[str, Any]:
    cfg = load_config()
    if engine not in ENGINES:
        return {"success": False, "error": f"Unknown engine {engine}"}

    meta = ENGINES[engine]
    py = venv_python(meta["venv"])
    script = worker_script(meta["worker"])
    if not py.exists():
        return {
            "success": False,
            "engine": engine,
            "error": f"Venv missing. Run setup_venvs.ps1 (need {py})",
        }

    display_text = text or cfg["test_sentence"]
    spoken = to_spoken_text(display_text, cfg.get("spoken_name", SPOKEN_NAME))
    ref = Path(reference_wav) if reference_wav else ROOT / cfg["reference_wav"]
    if not ref.is_absolute():
        ref = ROOT / ref

    out_dir = ROOT / cfg.get("output_dir", "results")
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    raw_path = out_dir / f"{engine}_{stamp}_raw.wav"

    req: dict[str, Any] = {
        "text": spoken,
        "output_path": str(raw_path),
        "reference_wav": str(ref) if ref.exists() else None,
        "cache_dir": str(ROOT / cfg.get("cache_dir", "cache") / engine),
        "language": cfg.get("pocket_language"),
        "builtin_voice": cfg.get("pocket_builtin_voice", "alba"),
        "model": cfg.get("coqui_model"),
        "voice": voice or (cfg.get("kokoro_voices") or ["am_adam"])[0],
        "mode": mode or ("clone" if ref.exists() and meta["supports_clone"] else "builtin"),
    }

    ref_report = validate_reference(ref).to_dict() if ref.exists() else None
    if meta["supports_clone"] and engine == "coqui" and not (ref.exists() and ref_report and ref_report["ok"]):
        # Still attempt if exists with warnings; hard-fail if missing
        if not ref.exists():
            return {
                "success": False,
                "engine": engine,
                "error": "Coqui YourTTS needs a valid owned reference WAV (speaker_wav).",
                "reference": ref_report or validate_reference(ref).to_dict(),
                "display_name": DISPLAY_NAME,
                "spoken_text": spoken,
            }

    wall0 = time.perf_counter()
    proc = subprocess.run(
        [str(py), str(script)],
        input=json.dumps(req),
        capture_output=True,
        text=True,
        timeout=timeout_sec,
        cwd=str(ROOT),
    )
    wall = time.perf_counter() - wall0

    if proc.returncode != 0 and not proc.stdout.strip():
        return {
            "success": False,
            "engine": engine,
            "error": proc.stderr[-2000:] or f"exit {proc.returncode}",
            "wall_sec": wall,
            "display_name": DISPLAY_NAME,
            "spoken_text": spoken,
            "reference": ref_report,
        }

    try:
        result = json.loads(proc.stdout.strip().splitlines()[-1])
    except json.JSONDecodeError:
        return {
            "success": False,
            "engine": engine,
            "error": "Invalid worker JSON",
            "stdout": proc.stdout[-1500:],
            "stderr": proc.stderr[-1500:],
            "wall_sec": wall,
        }

    result["wall_sec"] = wall
    result["display_name"] = DISPLAY_NAME
    result["display_text"] = display_text
    result["spoken_text"] = spoken
    result["reference"] = ref_report
    result["stderr_tail"] = (proc.stderr or "")[-500:]
    if not result.get("success"):
        return result

    # Apply rugged preset in base process (shared FX)
    preset_name = (preset or "none").lower()
    final_path = out_dir / f"{engine}_{stamp}_{preset_name}.wav"
    audio, sr = sf.read(result["output_path"], dtype="float32")
    processed = apply_fx(np.asarray(audio), int(sr), preset_name)
    sf.write(str(final_path), processed, int(sr))
    result["preset"] = preset_name
    result["output_path"] = str(final_path.resolve())
    result["presets_available"] = list(PRESETS.keys())
    return result
