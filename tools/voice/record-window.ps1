# tools/voice/record-window.ps1 — открыть ВИДИМОЕ окно для записи голоса.
#
# Зачем. Записывающие стенды (`wakeword-enroll.py`, `voice-reading.py`) разговаривают с ЧЕЛОВЕКОМ:
# печатают подсказку, ждут, отвечают «принято». Запущенные агентом из-под инструмента, они копят
# вывод и показывают его агенту — человек сидит перед молчащим экраном и не знает, когда говорить.
# Поэтому окно отдельное, на рабочем столе владельца.
#
# Кодировка задаётся здесь, а не в стенде: Python пишет UTF-8, и если консоль осталась в 866-й
# кодовой странице, подсказки превратятся в кракозябры ровно в тот момент, когда их надо читать.

# ⚠️ Аргументы стенда принимаются ХВОСТОМ (`ValueFromRemainingArguments`), а не одной строкой.
# Строка «--slug jarvis --count 50», пропущенная через `Start-Process -ArgumentList`, теряет
# целостность: пробелы разрывают её на отдельные аргументы, и стенд получает `--slug` без значения
# (поймано дважды за вечер 2026-08-01 — сначала на заголовке окна, потом здесь).
param(
  [string]$Tool = 'wakeword-enroll.py',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$ToolArgs
)

$ErrorActionPreference = 'Stop'
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "KLAS · запись голоса · $Tool"

$py = 'F:\KLAS\voice\venv-wakeword\Scripts\python.exe'
$script = Join-Path 'F:\KLAS\tools\voice' $Tool

if (-not (Test-Path $py))     { Write-Host "нет питона: $py" -ForegroundColor Red; Read-Host; exit 1 }
if (-not (Test-Path $script)) { Write-Host "нет стенда: $script" -ForegroundColor Red; Read-Host; exit 1 }

Set-Location 'F:\KLAS'
if ($ToolArgs) { & $py $script @ToolArgs } else { & $py $script }

Write-Host ''
Read-Host 'Готово. Enter — закрыть окно'
