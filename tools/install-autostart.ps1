# tools/install-autostart.ps1 — ТИХИЙ автозапуск ВСЕГО KLAS при входе в систему (баг 02 + идея 10).
#
# При входе владельца Планировщик запускает трей-контроллер (klas-control.vbs) СКРЫТО, без окна:
#   • поднимается весь стек — docker-сервисы (kiwix/open-webui/homepage/caddy) + llama-swap + funnel;
#   • в области уведомлений появляется иконка «Кот Криник» с меню (открыть пульт / остановить и выйти);
#   • показывается пуш-уведомление «KLAS запущен и работает».
# Docker (restart:unless-stopped) и Tailscale поднимаются и сами — трей объединяет всё под одной
# иконкой, уведомляет владельца и даёт ручное управление. Окно консоли НЕ появляется (баг 02, симптом 3).
#
# Идемпотентно (пересоздаёт). Запуск (один раз, от владельца): powershell -File F:\KLAS\tools\install-autostart.ps1
# Удалить: Unregister-ScheduledTask -TaskName "KLAS" -Confirm:$false

$ErrorActionPreference = 'Stop'
$task = 'KLAS'
$vbs  = 'F:\KLAS\tools\klas-control.vbs'
if (-not (Test-Path $vbs)) { Write-Error "Не найден $vbs"; exit 1 }

# Снять прежнюю задачу-предшественника (запускала только llama-swap) — её роль поглотил трей.
Unregister-ScheduledTask -TaskName 'KLAS llama-swap' -Confirm:$false -ErrorAction SilentlyContinue

# Действие: wscript запускает скрытый трей-лаунчер (//B — без диалогов, //Nologo — без баннера).
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B //Nologo `"$vbs`""
# Триггер: при входе текущего пользователя в систему.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# Настройки: не глушить по простою/питанию (сервер должен жить), без лимита времени выполнения.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings `
    -Description 'KLAS: тихий автозапуск всего стека + трей-иконка (баг 02, идея 10)' -Force | Out-Null

Write-Host "✔ Автозапуск '$task' создан: при входе — тихий подъём KLAS + трей «Кот Криник» + пуш."
Write-Host "  Проверить:       schtasks /query /tn `"$task`""
Write-Host "  Запустить сейчас: schtasks /run /tn `"$task`""
Write-Host "  Удалить:         Unregister-ScheduledTask -TaskName `"$task`" -Confirm:`$false"
