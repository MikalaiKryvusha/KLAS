# tools/restart-llama-swap.ps1 - restart llama-swap with new config
# Run:  powershell -File F:\KLAS\tools\restart-llama-swap.ps1
# Uses the same method as klas.ps1 -Action up (start-hidden.vbs)

$ErrorActionPreference = 'SilentlyContinue'

Write-Host "=== KLAS restart-llama-swap ===" -ForegroundColor Cyan

# 1) Kill llama-swap and llama-server
Write-Host "`n-- Stopping llama-swap and llama-server --" -ForegroundColor Yellow
Get-Process llama-swap,llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Check if stopped
$remaining = Get-Process llama-swap,llama-server -ErrorAction SilentlyContinue
if ($remaining) {
    Write-Host "  WARNING: some processes still running" -ForegroundColor Red
    Get-Process llama-swap,llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
}

# 2) Start llama-swap using start-hidden.vbs (same as klas.ps1)
Write-Host "`n-- Starting llama-swap via start-hidden.vbs --" -ForegroundColor Yellow
$vbsPath = "F:\KLAS\llama-swap\start-hidden.vbs"
if (Test-Path $vbsPath) {
    Start-Process wscript.exe -ArgumentList "//B","//Nologo","`"$vbsPath`""
    Write-Host "  llama-swap started via VBS" -ForegroundColor Green
} else {
    Write-Host "  ERROR: start-hidden.vbs not found at $vbsPath" -ForegroundColor Red
    Write-Host "  Try: powershell -File F:\KLAS\tools\klas.ps1 -Action up"
    exit 1
}

# 3) Wait and check
Start-Sleep -Seconds 5
Write-Host "`n-- Checking --" -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8080/health" -TimeoutSec 5
    Write-Host "  llama-swap is alive! /health: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
    Write-Host "  llama-swap started but /health not responding (model may still load)" -ForegroundColor Yellow
    Write-Host "  Error: $_"
}

Write-Host "`n=== DONE. Zoo Code: do /pause then /resume to reconnect ===" -ForegroundColor Cyan
