// gpu-watch-launcher.js -- starts gpu-watch.ps1 WITHOUT allocating a console window.
//
// WHY THIS FILE EXISTS (written 2026-08-16 by the KAGO agent, on the owner's explicit instruction
// "fix KLAS"; the finding came from the owner himself -- "maybe it is the neighbouring agent?").
//
// THE DEFECT. The scheduled task \KLAS-gpu-watch ran:
//     powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File F:\KLAS\tools\gpu-watch.ps1
// every 5 minutes, with LogonType=InteractiveToken. `-WindowStyle Hidden` hides PowerShell's OWN
// window, but powershell.exe is a CONSOLE subsystem program and still needs a console. On Windows 11
// the "default terminal application" setting hands that console to Windows Terminal, which the
// system starts through DCOM (WindowsTerminal.exe -Embedding, parent svchost -k DcomLaunch). The
// PowerShell process finishes and exits -- and the terminal window STAYS BEHIND, empty.
//
// Measured on the owner's machine 2026-08-16: one abandoned window every 5 minutes, matching this
// task's schedule to the second (15:09:58, 15:29:58, 15:34:58, 15:39:58, 16:04:58 -- the task starts
// at 14:54:57 and repeats every 5 min). The owner had to close them by hand for hours.
//
// WHY NOT "run whether user is logged on or not". That would put the task in session 0 and BREAK
// the observer by design: gpu-watch.ps1 documents that GetLastInputInfo reports the idle time of the
// CALLING session only, so it must live in the owner's interactive session (researches/29).
//
// THE FIX. wscript.exe belongs to the GUI subsystem: it allocates no console, so nothing is handed
// to the default terminal and no window can be left behind. WScript.Shell.Run with window style 0
// starts PowerShell fully hidden, and bWaitOnReturn=false lets this launcher exit immediately --
// the watcher's own lifetime is governed by the task's ExecutionTimeLimit exactly as before.
//
// NOTHING ELSE CHANGES: same script, same arguments, same interactive session, same user, same
// schedule. Only the way the process is started.
//
// ASCII ONLY, deliberately -- this project's own rule for its script files (EXP-0066).

var PS = 'powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "F:\\KLAS\\tools\\gpu-watch.ps1"';

var HIDDEN = 0;          // window style: no window at all
var DO_NOT_WAIT = false; // return at once; the task's time limit still bounds the watcher

new ActiveXObject('WScript.Shell').Run(PS, HIDDEN, DO_NOT_WAIT);
