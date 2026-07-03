# tools/install-autostart.ps1 — ставит автозапуск llama-swap при входе в систему (живучесть, Фаза 4).
# Docker (restart:unless-stopped) и Tailscale автостартуют сами; llama-swap — нет, эта задача чинит.
# Создаёт задачу Планировщика «KLAS llama-swap» (триггер onlogon). Идемпотентно (пересоздаёт).
# Запуск (один раз, от владельца): powershell -File F:\KLAS\tools\install-autostart.ps1
# Удалить:  schtasks /delete /tn "KLAS llama-swap" /f

$ErrorActionPreference = 'Stop'
$task = 'KLAS llama-swap'
$bat  = 'F:\KLAS\llama-swap\start-llama-swap.bat'
if (-not (Test-Path $bat)) { Write-Error "Не найден $bat"; exit 1 }

# /rl LIMITED — без прав админа; /it — только при интерактивном входе владельца
schtasks /create /f /tn $task /tr "cmd /c `"$bat`"" /sc onlogon /rl LIMITED | Out-Null
Write-Host "✔ Задача автозапуска '$task' создана (триггер: вход в систему)."
Write-Host "  Проверить:  schtasks /query /tn `"$task`""
Write-Host "  Запустить сейчас:  schtasks /run /tn `"$task`""
Write-Host "  Удалить:  schtasks /delete /tn `"$task`" /f"
