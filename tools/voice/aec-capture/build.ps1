# tools/voice/aec-capture/build.ps1 — сборка помощника захвата с подавлением эха (bugs/25).
#
# Компилятор на этой машине есть (Visual Studio Build Tools 2022), но cl.exe НЕ лежит в PATH:
# его окружение поднимает vcvars64.bat. Поэтому сборка идёт через cmd — иначе «cl не найден»
# выглядит как отсутствие компилятора, хотя он на месте.
#
# Запуск:  powershell -File F:\KLAS\tools\voice\aec-capture\build.ps1
# Результат: F:\KLAS\tools\voice\aec-capture\aec-capture.exe

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'

if (-not (Test-Path $vcvars)) { throw "vcvars64.bat не найден: $vcvars" }

$src = Join-Path $dir 'aec_capture.cpp'
$exe = Join-Path $dir 'aec-capture.exe'
$obj = Join-Path $dir 'aec_capture.obj'

# /EHsc — исключения C++; /O2 — оптимизация (поток идёт непрерывно); /W3 — предупреждения видны.
$cmd = "`"$vcvars`" >nul 2>&1 && cl /nologo /EHsc /O2 /W3 `"$src`" /Fe:`"$exe`" /Fo:`"$obj`""
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { throw "сборка не удалась (код $LASTEXITCODE)" }

Remove-Item $obj -ErrorAction SilentlyContinue
Write-Host "OK: $exe"
