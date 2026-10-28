# RA-ONE Module 7 - Build Windows installer (NSIS via electron-builder).
# Order: tests -> Vite UI -> PyInstaller backend -> electron-builder.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host '=== RA-ONE desktop installer build ===' -ForegroundColor Cyan

Write-Host "`n[1/4] Frontend + backend unit tests..."
npm test
if ($LASTEXITCODE -ne 0) { throw 'npm test failed' }

Push-Location (Join-Path $Root 'backend')
try {
  & .\.venv\Scripts\python.exe -m pytest -q --tb=line
  if ($LASTEXITCODE -ne 0) { throw 'pytest failed' }
} finally {
  Pop-Location
}

Write-Host "`n[2/4] Vite production build -> dist/"
npm run build
if ($LASTEXITCODE -ne 0) { throw 'vite build failed' }

Write-Host "`n[3/4] PyInstaller backend -> backend/dist/raone-backend/"
powershell -ExecutionPolicy Bypass -File (Join-Path $Root 'backend\scripts\build_backend.ps1')
if ($LASTEXITCODE -ne 0) { throw 'backend PyInstaller build failed' }

$backendExe = Join-Path $Root 'backend\dist\raone-backend\raone-backend.exe'
if (-not (Test-Path $backendExe)) { throw "Missing $backendExe" }

Write-Host "`n[4/4] electron-builder (NSIS)..."
npx electron-builder --win
if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }

Write-Host "`nDone. Installer output is under release/ (see electron-builder directories)." -ForegroundColor Green
Write-Host 'Test on a clean account: install -> reboot -> clap wake -> uninstall removes login item.'
