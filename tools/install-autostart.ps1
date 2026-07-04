# tools/install-autostart.ps1 — ставит ТИХИЙ фоновый автозапуск llama-swap при входе (Фаза 4, баг 02).
# Docker (restart:unless-stopped) и Tailscale автостартуют сами; llama-swap — нет, эта задача чинит.
#
# Тихо (баг 02, симптом 3): задача вызывает wscript //B start-hidden.vbs — окно консоли НЕ появляется.
# Самовосстановление (баг 02, симптом 2): при сбое процесса задача перезапускается (3 попытки, 1 мин) —
# монитор llama-swap на пульте остаётся зелёным.
# Идемпотентно (пересоздаёт). Запуск (один раз, от владельца): powershell -File F:\KLAS\tools\install-autostart.ps1
# Удалить:  Unregister-ScheduledTask -TaskName "KLAS llama-swap" -Confirm:$false

$ErrorActionPreference = 'Stop'
$task = 'KLAS llama-swap'
$vbs  = 'F:\KLAS\llama-swap\start-hidden.vbs'
if (-not (Test-Path $vbs)) { Write-Error "Не найден $vbs"; exit 1 }

# Действие: wscript запускает скрытый лаунчер (//B — batch-режим без диалогов, //Nologo — без баннера).
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$vbs`""
# Триггер: при входе текущего пользователя в систему.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Настройки: авто-рестарт при сбое + не глушить по простою/питанию (сервер должен жить).
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # без лимита времени выполнения (сервис работает постоянно)

Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings `
    -Description 'KLAS: тихий фоновый автозапуск llama-swap (баг 02)' -Force | Out-Null

Write-Host "✔ Задача автозапуска '$task' создана (тихо, wscript hidden, авто-рестарт при сбое)."
Write-Host "  Проверить:      schtasks /query /tn `"$task`""
Write-Host "  Запустить сейчас: schtasks /run /tn `"$task`""
Write-Host "  Удалить:        Unregister-ScheduledTask -TaskName `"$task`" -Confirm:`$false"
