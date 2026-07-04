# tools/install-desktop-shortcuts.ps1 — создаёт на Рабочем столе 3 ярлыка KLAS (идея 13):
#   • Run KLAS            — тихо поднять весь стек (klas-run.vbs up)
#   • Stop KLAS           — тихо погасить весь стек (klas-run.vbs down)
#   • KLAS Control Panel  — открыть веб-пульт локально (http://localhost/) в браузере по умолчанию
# Все с иконкой «Кот Криник». Идемпотентно (перезаписывает). Вызывается из deploy.mjs в конце
# установки, либо вручную: powershell -File F:\KLAS\tools\install-desktop-shortcuts.ps1
$ErrorActionPreference = 'Stop'

$root    = 'F:\KLAS'
$icon    = "$root\logo\homepage.ico"          # favicon «Кот Криник» (не баннер KLAS.jpg)
$runVbs  = "$root\tools\klas-run.vbs"
$panel   = 'http://localhost/'                # единый локальный вход через Caddy :80
$desktop = [Environment]::GetFolderPath('Desktop')
$ws      = New-Object -ComObject WScript.Shell

# --- .lnk для действий (Run/Stop): тихий запуск через wscript + klas-run.vbs ---
function New-ActionShortcut($name, $action, $desc) {
    $lnk = Join-Path $desktop "$name.lnk"
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath       = 'wscript.exe'
    $s.Arguments        = "//B //Nologo `"$runVbs`" $action"
    $s.IconLocation     = "$icon,0"
    $s.WorkingDirectory = $root
    $s.Description      = $desc
    $s.Save()
    Write-Host "[ok] $lnk"
}
New-ActionShortcut 'Run KLAS'  'up'   'Запустить весь стек KLAS'
New-ActionShortcut 'Stop KLAS' 'down' 'Остановить весь стек KLAS'

# --- Control Panel: интернет-ярлык (.url) открывает пульт в браузере по умолчанию, со своей иконкой ---
$urlFile = Join-Path $desktop 'KLAS Control Panel.url'
@(
    '[InternetShortcut]',
    "URL=$panel",
    "IconFile=$icon",
    'IconIndex=0'
) | Set-Content -Path $urlFile -Encoding ASCII
Write-Host "[ok] $urlFile"

Write-Host 'Готово. На Рабочем столе: Run KLAS / Stop KLAS / KLAS Control Panel (иконка Кот Криник).'
