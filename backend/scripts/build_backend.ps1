# Module 4: build backend\dist\raone-backend\raone-backend.exe (PyInstaller onedir).
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File backend\scripts\build_backend.ps1
# Models are NOT bundled; point RAONE_MODELS_DIR at backend\models (or the installer's copy).
$ErrorActionPreference = 'Stop'
$backend = Split-Path -Parent $PSScriptRoot
Push-Location $backend
try {
    $py = Join-Path $backend '.venv\Scripts\python.exe'
    if (-not (Test-Path $py)) { throw "Missing venv: $py (see backend\README.md)" }
    & $py -m pip install -q -r requirements-build.txt
    if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
    & $py -m PyInstaller raone-backend.spec --noconfirm --clean
    if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed' }
    $exe = Join-Path $backend 'dist\raone-backend\raone-backend.exe'
    $mb = [int]((Get-ChildItem (Split-Path $exe) -Recurse | Measure-Object Length -Sum).Sum / 1MB)
    Write-Host "Built $exe ($mb MB, models not included)"
} finally {
    Pop-Location
}
