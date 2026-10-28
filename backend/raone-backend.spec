# PyInstaller spec for the RA-ONE desktop backend (Module 4). Build: scripts/build_backend.ps1
# onedir (faster start than onefile). Models stay OUTSIDE the bundle: set RAONE_MODELS_DIR.
# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import (
    collect_all, collect_data_files, collect_dynamic_libs, collect_submodules, copy_metadata,
)

# piper-tts metadata: OfflineTTSEngine reports its version via importlib.metadata
datas = [("app/voice/presets.json", "app/voice")] + copy_metadata("piper-tts")
binaries = []
hiddenimports = collect_submodules("app") + collect_submodules("uvicorn")

# Native libs + data files these packages load at runtime
for pkg in ("onnxruntime", "ctranslate2", "vosk", "faster_whisper", "_soundfile_data", "librosa"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Piper: espeak-ng data + espeakbridge.pyd; skip its training/http extras (torch, flask)
datas += collect_data_files("piper", excludes=["train/**", "templates/**", "img/**"])
binaries += collect_dynamic_libs("piper")
hiddenimports += collect_submodules(
    "piper", filter=lambda name: not name.startswith(("piper.train", "piper.http_server"))
)

a = Analysis(
    ["run_server.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports + ["webrtcvad", "_webrtcvad", "soundfile", "_soundfile"],
    hookspath=["pyinstaller_hooks"],
    excludes=[
        "tkinter", "matplotlib", "IPython", "pytest", "_pytest", "torch", "flask",
        "piper.train", "piper.http_server", "PyInstaller", "onnxruntime.quantization",
    ],
    noarchive=False,
    # numba only caches compiled kernels for functions whose .py source exists on disk.
    # With librosa's sources shipped, the TTS warm-up drops from ~25 s to ~3 s after the first
    # boot (cache in _internal/librosa/__pycache__, or numba's per-user cache if read-only).
    module_collection_mode={"librosa": "pyz+py"},
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="raone-backend",
    console=False,  # tray app: no console window; logs go to %LOCALAPPDATA%\RAONE\logs
    icon="../../raone_logo_icon_favicon_pack/favicon.ico",
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="raone-backend", upx=False)
