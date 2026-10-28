# RA-ONE Module 2 — Ollama setup (asks before any model download).
# Keeps Ollama local-only. Does not disable Windows security controls.
$ErrorActionPreference = 'Stop'

Write-Host '=== RA-ONE Offline LLM Setup (Ollama) ===' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Preferred model: qwen3:1.7b  (~1.4 GB download, ~3 GB RAM on CPU)'
Write-Host 'Fallback model:  qwen3:0.6b  (~0.5 GB download, ~1.5 GB RAM on CPU)'
Write-Host 'Target hardware: Intel i7-8650U, 16 GB RAM, CPU-only'
Write-Host 'API bind:        127.0.0.1:11434 (local only)'
Write-Host ''
Write-Host 'This script will NOT pull models unless you type YES.'
Write-Host ''

function Test-Ollama {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -UseBasicParsing -TimeoutSec 3
    return $r.StatusCode -eq 200
  } catch { return $false }
}

function Find-Ollama {
  $cmd = Get-Command ollama -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd }
  $local = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  if (Test-Path $local) { return Get-Command $local }
  return $null
}

$ollamaCmd = Find-Ollama
if (-not $ollamaCmd) {
  Write-Host 'Ollama not found — installing it automatically...' -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    & winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements
  }
  $ollamaCmd = Find-Ollama
  if (-not $ollamaCmd) {
    $setup = Join-Path $env:TEMP 'OllamaSetup.exe'
    Write-Host 'Downloading the official Ollama installer...'
    Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $setup -UseBasicParsing
    Start-Process -FilePath $setup -ArgumentList '/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES' -Wait
    Remove-Item $setup -ErrorAction SilentlyContinue
    $ollamaCmd = Find-Ollama
  }
  if (-not $ollamaCmd) {
    Write-Host 'Automatic install failed. Install from https://ollama.com/download/windows and re-run.' -ForegroundColor Red
    exit 1
  }
}

Write-Host "Found: $($ollamaCmd.Source)"
if (-not (Test-Ollama)) {
  Write-Host 'Starting Ollama serve in background (local)...' -ForegroundColor Yellow
  Start-Process -FilePath $ollamaCmd.Source -ArgumentList 'serve' -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

if (-not (Test-Ollama)) {
  Write-Host 'Ollama API still unreachable at http://127.0.0.1:11434' -ForegroundColor Red
  exit 2
}

Write-Host 'Ollama is reachable.' -ForegroundColor Green
& $ollamaCmd.Source list

Write-Host ''
$confirm = Read-Host 'Download preferred model qwen3:1.7b now? Type YES to confirm'
if ($confirm -eq 'YES') {
  Write-Host 'Pulling qwen3:1.7b (this may take several minutes)...'
  & $ollamaCmd.Source pull qwen3:1.7b
} else {
  Write-Host 'Skipped qwen3:1.7b download.'
}

$confirm2 = Read-Host 'Download fallback model qwen3:0.6b now? Type YES to confirm'
if ($confirm2 -eq 'YES') {
  Write-Host 'Pulling qwen3:0.6b...'
  & $ollamaCmd.Source pull qwen3:0.6b
} else {
  Write-Host 'Skipped qwen3:0.6b download.'
}

Write-Host ''
Write-Host 'Done. Verify with: GET http://127.0.0.1:8000/api/llm/health'
Write-Host 'Do not expose Ollama to the public internet.'
& $ollamaCmd.Source list
