' klas-run.vbs <up|down> — тихо (без окна консоли) выполняет klas.ps1 -Action <up|down> (идея 13).
' На него ссылаются ярлыки «Run KLAS» (up) и «Stop KLAS» (down). Run(..., 0, False): 0 = скрыто.
Set sh = CreateObject("WScript.Shell")
act = "up"
If WScript.Arguments.Count > 0 Then act = WScript.Arguments(0)
sh.Run "powershell -NoProfile -ExecutionPolicy RemoteSigned -File ""F:\KLAS\tools\klas.ps1"" -Action " & act, 0, False
