# tools/install-klas-shortcut.ps1 — создаёт ярлык «KLAS» с иконкой Кота Криника (favicon), идея 10.
# Ярлык запускает трей-контроллер СКРЫТО (klas-control.vbs → трей-иконка + подъём стека + пуш).
# Кладётся в корень проекта (F:\KLAS\KLAS.lnk) и на Рабочий стол. Идемпотентно (перезаписывает).
# Запуск (один раз, от владельца): powershell -File F:\KLAS\tools\install-klas-shortcut.ps1
$ErrorActionPreference = 'Stop'

$vbs  = 'F:\KLAS\tools\klas-control.vbs'
# ВАЖНО: иконка — favicon «Кот Криник» (homepage.ico), НЕ большой logo-баннер KLAS.jpg.
$icon = 'F:\KLAS\logo\homepage.ico'
$targets = @(
    'F:\KLAS\KLAS.lnk',
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'KLAS.lnk')
)

$ws = New-Object -ComObject WScript.Shell
foreach ($lnk in $targets) {
    $s = $ws.CreateShortcut($lnk)
    $s.TargetPath       = 'wscript.exe'
    $s.Arguments        = "//B //Nologo `"$vbs`""
    $s.IconLocation     = "$icon,0"
    $s.WorkingDirectory = 'F:\KLAS'
    $s.Description       = 'Запустить KLAS (трей-иконка · пульт управления)'
    $s.Save()
    Write-Host "✔ Ярлык создан: $lnk"
}
Write-Host "Готово. Двойной клик по ярлыку — KLAS поднимается, в трее появляется Кот Криник."
