' start-hidden.vbs — запускает llama-swap ПОЛНОСТЬЮ в фоне, без окна консоли (баг 02, симптом 3).
' Task Scheduler вызывает: wscript //B //Nologo start-hidden.vbs
' WScript.Shell.Run(cmd, 0, False): 0 = скрытое окно, False = не ждать завершения.
' Внутри — тот же start-llama-swap.bat (он же используется вручную), просто без видимого окна.
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c ""F:\KLAS\llama-swap\start-llama-swap.bat""", 0, False
