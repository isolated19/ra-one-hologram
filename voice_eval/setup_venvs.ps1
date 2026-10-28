# Create isolated venvs for each TTS engine (Python 3.12).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Py = "py"
$PyArgs = @("-3.12")

function New-EngineVenv($Name, $ReqFile) {
  $venv = Join-Path $Root "venvs\$Name"
  Write-Host "`n=== Setting up $Name ($venv) ===" -ForegroundColor Cyan
  if (-not (Test-Path $venv)) {
    & $Py @PyArgs -m venv $venv
  }
  $pip = Join-Path $venv "Scripts\pip.exe"
  & $pip install --upgrade pip wheel
  & $pip install -r (Join-Path $Root "requirements\$ReqFile")
}

New-EngineVenv "base" "base.txt"
New-EngineVenv "pocket" "pocket.txt"
New-EngineVenv "coqui" "coqui.txt"
New-EngineVenv "kokoro" "kokoro.txt"

Write-Host "`nDone. Place your owned reference at voice_eval\reference\my_voice.wav" -ForegroundColor Green
