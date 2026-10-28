"""Local voice-comparison UI server (isolated from main RA-ONE FastAPI)."""

from __future__ import annotations

import shutil
from pathlib import Path

import yaml
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from voice_eval.orchestrator import ROOT, engine_status, load_config, run_engine
from voice_eval.pronunciation import DISPLAY_NAME, SPOKEN_NAME, to_spoken_text
from voice_eval.reference_validator import validate_reference
from voice_eval.rugged_fx import PRESETS

STATIC = ROOT / "static"
REF_DIR = ROOT / "reference"
RESULTS = ROOT / "results"

app = FastAPI(title="RA-ONE Voice Cloning Evaluation", version="0.1.0")
if STATIC.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.get("/", response_class=HTMLResponse)
def index():
    html = STATIC / "index.html"
    if not html.exists():
        raise HTTPException(404, "static/index.html missing")
    return HTMLResponse(html.read_text(encoding="utf-8"))


@app.get("/api/meta")
def meta():
    cfg = load_config()
    ref = ROOT / cfg["reference_wav"]
    return {
        "display_name": DISPLAY_NAME,
        "spoken_name": SPOKEN_NAME,
        "test_sentence": cfg["test_sentence"],
        "engines": engine_status(),
        "presets": list(PRESETS.keys()),
        "reference": validate_reference(ref).to_dict(),
        "note": "Does not replace the production Piper TTS engine.",
    }


@app.get("/api/reference")
def reference_status():
    cfg = load_config()
    return validate_reference(ROOT / cfg["reference_wav"]).to_dict()


@app.post("/api/reference/upload")
async def upload_reference(file: UploadFile = File(...)):
    REF_DIR.mkdir(parents=True, exist_ok=True)
    dest = REF_DIR / "my_voice.wav"
    suffix = Path(file.filename or "upload.wav").suffix.lower() or ".wav"
    if suffix not in {".wav", ".flac", ".ogg"}:
        raise HTTPException(400, "Upload WAV/FLAC/OGG only")
    tmp = REF_DIR / f"_upload{suffix}"
    with open(tmp, "wb") as f:
        shutil.copyfileobj(file.file, f)
    if suffix != ".wav":
        # Keep original format path for validators that accept flac/ogg
        dest = REF_DIR / f"my_voice{suffix}"
        cfg_path = ROOT / "config.yaml"
        cfg = load_config()
        cfg["reference_wav"] = f"reference/my_voice{suffix}"
        with open(cfg_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(cfg, f)
    else:
        dest = REF_DIR / "my_voice.wav"
    shutil.move(str(tmp), str(dest))
    report = validate_reference(dest).to_dict()
    return report


@app.post("/api/generate")
async def generate(
    engine: str = Form(...),
    text: str = Form(""),
    preset: str = Form("commander"),
    voice: str = Form(""),
    mode: str = Form(""),
):
    cfg = load_config()
    result = run_engine(
        engine,
        text=text or cfg["test_sentence"],
        preset=preset,
        voice=voice or None,
        mode=mode or None,
        timeout_sec=1200,
    )
    if not result.get("success"):
        # Still return JSON for UI to show error
        return result
    # Expose relative download URL
    out = Path(result["output_path"])
    result["download_url"] = f"/api/audio/{out.name}"
    result["pronunciation_check"] = {
        "ui_display": DISPLAY_NAME,
        "tts_speaks": SPOKEN_NAME,
        "spoken_text": to_spoken_text(text or cfg["test_sentence"]),
    }
    return result


@app.get("/api/audio/{name}")
def audio_file(name: str):
    path = RESULTS / name
    if not path.exists() or ".." in name:
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/wav", filename=name)


def main():
    import uvicorn

    cfg = load_config()
    RESULTS.mkdir(parents=True, exist_ok=True)
    uvicorn.run(
        "voice_eval.server:app",
        host=cfg.get("server_host", "127.0.0.1"),
        port=int(cfg.get("server_port", 8765)),
        reload=False,
    )


if __name__ == "__main__":
    main()
