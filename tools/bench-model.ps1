# tools/bench-model.ps1 — замер модели-кандидата одной командой (Фаза 2b, researches/02).
# Гоняет llama-bench (скорость промпта pp512 и генерации tg128, всё на GPU, flash attention),
# показывает пик VRAM. Сервер llama-swap/llama-server на 8080 НЕ трогает (llama-bench грузит
# модель сам) — но для чистоты замера лучше, чтобы VRAM была свободна (модели llama-swap спят).
# Запуск: powershell -File F:\KLAS\tools\bench-model.ps1 -Model "F:\KLAS\LLMs\LLAMACPP_MODELS\<файл>.gguf"

param(
    [Parameter(Mandatory=$true)][string]$Model,
    [int]$Repetitions = 3   # повторов на метрику (усреднение llama-bench)
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Model)) { Write-Error "Модель не найдена: $Model"; exit 1 }

$f = Get-Item $Model
Write-Host "=== KLAS bench: $($f.Name) ($([math]::Round($f.Length/1GB,2)) GB) — $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" -ForegroundColor Cyan
Write-Host "VRAM до запуска: $(nvidia-smi --query-gpu=memory.used --format=csv,noheader)"

# llama-bench: pp512 (скорость чтения промпта) + tg128 (скорость генерации), все слои на GPU, FA on
& "F:\KLAS\llamacpp\llama-bench.exe" -m $Model -ngl 99 -fa 1 -r $Repetitions

Write-Host "VRAM после (модель выгружается сама по завершении): $(nvidia-smi --query-gpu=memory.used --format=csv,noheader)"
Write-Host "=== конец bench ===" -ForegroundColor Cyan
