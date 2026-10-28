# RA-ONE permission audit/setup helper. Does not bypass Windows security controls.
$ErrorActionPreference = 'Stop'
Write-Host 'RA-ONE: Windows permissions review' -ForegroundColor Cyan

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "Administrator (current process): $isAdmin"
if ($isAdmin) {
  Write-Host 'WARNING: Do not run the main RA-ONE assistant elevated continuously.' -ForegroundColor Yellow
}

$homeFolder = Join-Path $env:LOCALAPPDATA 'RAONE'
$dirs = @('data', 'logs', 'models', 'exports')
foreach ($dir in $dirs) {
  New-Item -Path (Join-Path $homeFolder $dir) -ItemType Directory -Force | Out-Null
}
Write-Host "App data: $homeFolder"

# Optional: print Module 1 PermissionManager status via Python 3.12
$backend = Join-Path $PSScriptRoot 'backend'
$py = Join-Path $backend '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { $py = 'py' }
try {
  Push-Location $backend
  if ($py -eq 'py') {
    & py -3.12 -c "from app.permissions import get_permission_manager; import json; print(json.dumps(get_permission_manager().status_report(), indent=2))"
  } else {
    & $py -c "from app.permissions import get_permission_manager; import json; print(json.dumps(get_permission_manager().status_report(), indent=2))"
  }
  Pop-Location
} catch {
  Write-Host "Python status report skipped: $_" -ForegroundColor DarkYellow
  if ((Get-Location).Path -eq $backend) { Pop-Location }
}

Write-Host 'Opening Windows microphone privacy settings. Enable access yourself.'
Start-Process 'ms-settings:privacy-microphone'
Write-Host 'If RA-ONE runs in a browser, permit microphone access for its localhost site as well.'
Write-Host 'Do not disable UAC. Do not run the main assistant as Administrator.'
Write-Host 'Keep local API ports bound to 127.0.0.1 and enforce permissions for any file/action tools.'
Write-Host 'API: GET http://127.0.0.1:8000/api/permissions/status'
