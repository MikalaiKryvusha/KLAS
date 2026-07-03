# tools/health-check.ps1 — здоровье LLM-стека KLAS одной командой.
# Показывает: жив ли llama-server (/health, /props, /v1/models), кто слушает порт, процессы llama,
# занятость VRAM/GPU (nvidia-smi). Ничего не меняет — только читает.
# Запуск:  powershell -File F:\KLAS\tools\health-check.ps1 [-Port 8080]

param(
    [int]$Port = 8080  # порт llama-server; kiwix (docker) маппит тот же 8080 — см. карту проекта
)

$ErrorActionPreference = 'SilentlyContinue'
Write-Host "=== KLAS health-check (порт $Port) — $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" -ForegroundColor Cyan

# 1) Кто слушает порт (llama-server? kiwix-docker? никто?)
Write-Host "`n-- Порт $Port --" -ForegroundColor Yellow
$listeners = netstat -ano | Select-String ":$Port\s" | Select-String 'LISTENING'
if ($listeners) {
    $listeners | ForEach-Object {
        $procId = ($_ -split '\s+')[-1]
        $proc = Get-Process -Id $procId
        Write-Host "  LISTENING pid=$procId ($($proc.ProcessName))"
    }
} else { Write-Host "  порт свободен — никто не слушает" }

# 2) Процессы llama
Write-Host "`n-- Процессы llama --" -ForegroundColor Yellow
$llama = Get-Process | Where-Object { $_.ProcessName -match 'llama' }
if ($llama) { $llama | ForEach-Object { Write-Host "  $($_.ProcessName) pid=$($_.Id) RAM=$([math]::Round($_.WorkingSet64/1MB)) MB" } }
else { Write-Host "  llama-процессов нет" }

# 3) HTTP: /health, /props (реальный контекст и параметры), /v1/models
Write-Host "`n-- llama-server API --" -ForegroundColor Yellow
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
if ($health) {
    Write-Host "  /health: $($health | ConvertTo-Json -Compress)"
    $props = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/props" -TimeoutSec 5
    if ($props) {
        Write-Host "  /props: n_ctx=$($props.default_generation_settings.n_ctx) slots=$($props.total_slots) model=$($props.model_path)"
    }
    $models = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 5
    if ($models) { $models.data | ForEach-Object { Write-Host "  model: $($_.id)" } }
} else { Write-Host "  сервер на порту $Port не отвечает (это может быть kiwix — см. выше)" }

# 4) GPU / VRAM
Write-Host "`n-- GPU (nvidia-smi) --" -ForegroundColor Yellow
$smi = nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,noheader
if ($smi) { $smi | ForEach-Object { Write-Host "  $_" } } else { Write-Host "  nvidia-smi недоступен" }

Write-Host "`n=== конец health-check ===" -ForegroundColor Cyan
