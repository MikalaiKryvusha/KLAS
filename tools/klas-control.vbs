' klas-control.vbs — запускает трей-контроллер KLAS СКРЫТО, без окна консоли (идея 10).
' wscript вызывает этот файл; Run(..., 0, False): 0 = скрытое окно, False = не ждать.
' -Sta нужен для System.Windows.Forms (трей-иконка). RemoteSigned — запуск локального .ps1.
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -Sta -ExecutionPolicy RemoteSigned -File ""F:\KLAS\tools\klas.ps1"" -Action tray", 0, False
