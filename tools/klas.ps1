# tools/klas.ps1 — контроллер жизненного цикла KLAS (идея 10): трей-иконка Windows с меню
# [Open KLAS control panel] / [Stop KLAS and exit], тихий подъём всего стека и пуш-уведомление.
#
# Действия (-Action):
#   tray  (по умолчанию) — показать иконку KLAS в области уведомлений, поднять весь стек,
#                          пуш «KLAS запущен и работает»; меню: открыть пульт / остановить и выйти.
#   up    — просто поднять весь стек KLAS (docker-контейнеры + llama-swap + Tailscale Funnel).
#   down  — остановить весь стек KLAS (контейнеры + llama-swap + funnel).
#
# Запуск тихо (без окна): tools/klas-control.vbs → powershell -Sta klas.ps1 -Action tray.
# Ярлык с котиком ставит tools/install-klas-shortcut.ps1.
param([ValidateSet('up','down','tray')][string]$Action = 'tray')

$ErrorActionPreference = 'Continue'

# --- Константы KLAS (единый источник правды для контроллера) ---
$Compose    = 'F:\KLAS\docker-compose.yml'          # docker-стек: kiwix, open-webui, homepage, caddy
$Panel      = 'http://localhost:3005/'              # локальный пульт (homepage) — «control panel»
$IconPath   = 'F:\KLAS\logo\homepage.ico'           # иконка «Кот Криник» для трея и уведомлений
$LlamaVbs   = 'F:\KLAS\llama-swap\start-hidden.vbs' # тихий запуск LLM-менеджера llama-swap (баг 02)
$FunnelPort = '443'                                 # публичный HTTPS-доступ через Tailscale Funnel

# Поднять весь стек KLAS. Идемпотентно (docker up -d и funnel --bg безопасно вызывать повторно).
function Start-KlasStack {
    # 1) docker-сервисы (kiwix / open-webui / homepage / caddy)
    try { & docker compose -f $Compose up -d 2>&1 | Out-Null } catch {}
    # 2) llama-swap (LLM «спит, пока не позовут») — только если ещё не запущен; тихо, без окна
    if (-not (Get-Process llama-swap -ErrorAction SilentlyContinue)) {
        Start-Process wscript.exe -ArgumentList '//B','//Nologo',"`"$LlamaVbs`""
    }
    # 3) публичный доступ через интернет (Tailscale Funnel → Caddy :443)
    try { & tailscale funnel --bg $FunnelPort 2>&1 | Out-Null } catch {}
}

# Остановить весь стек KLAS: закрыть внешний доступ, погасить контейнеры и LLM.
function Stop-KlasStack {
    # 1) сначала закрываем внешний доступ (funnel), чтобы наружу не торчал мёртвый Caddy
    try { & tailscale funnel off 2>&1 | Out-Null } catch {}
    # 2) docker-контейнеры (stop, а не down — быстрый повторный подъём; restart-policy не поднимет)
    try { & docker compose -f $Compose stop 2>&1 | Out-Null } catch {}
    # 3) LLM-менеджер и его дочерние llama-server
    Get-Process llama-swap,llama-server -ErrorAction SilentlyContinue | Stop-Process -Force
}

switch ($Action) {
    'up'   { Start-KlasStack; return }
    'down' { Stop-KlasStack; return }
    'tray' {
        # Защита от повторного запуска: один трей = одна иконка (двойной клик по ярлыку не плодит копии)
        $script:mtx = New-Object System.Threading.Mutex($false, 'Global\KLAS_Tray_SingleInstance')
        if (-not $script:mtx.WaitOne(0)) { return }   # трей уже запущен — тихо выходим

        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing

        # Иконка KLAS в области уведомлений (system tray)
        $notify = New-Object System.Windows.Forms.NotifyIcon
        $notify.Icon    = New-Object System.Drawing.Icon($IconPath)
        $notify.Text    = 'KLAS — Krinik Local Agent System'
        $notify.Visible = $true

        # Контекстное меню по правой кнопке
        $menu = New-Object System.Windows.Forms.ContextMenuStrip
        $miOpen = $menu.Items.Add('Open KLAS control panel')
        $miOpen.add_Click({ Start-Process $Panel }.GetNewClosure())
        $miStop = $menu.Items.Add('Stop KLAS and exit')
        $miStop.add_Click({
            $notify.ShowBalloonTip(3000, 'KLAS', 'Останавливаю KLAS…', [System.Windows.Forms.ToolTipIcon]::None)
            Stop-KlasStack
            $notify.Visible = $false
            $notify.Dispose()
            [System.Windows.Forms.Application]::Exit()
        }.GetNewClosure())
        $notify.ContextMenuStrip = $menu
        # Двойной клик по иконке — быстро открыть пульт
        $notify.add_MouseDoubleClick({ Start-Process $Panel }.GetNewClosure())

        # Поднять весь стек и уведомить владельца пушем.
        # ToolTipIcon.None — БЕЗ синего info-круга; в уведомлении остаётся иконка-кот (иконка трея).
        Start-KlasStack
        $notify.ShowBalloonTip(5000, 'KLAS', 'KLAS запущен и работает', [System.Windows.Forms.ToolTipIcon]::None)

        # Цикл сообщений трея (живёт, пока не выбрано «Stop KLAS and exit»)
        [System.Windows.Forms.Application]::Run()
    }
}
