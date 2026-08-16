# Bug 28 — `\KLAS-gpu-watch` leaves an abandoned terminal window every five minutes

**Status:** 🔧 fix applied, awaiting verification on the next ticks
**Version/build:** `main` @ the state of 2026-08-16 · **When/context:** found by the OWNER, 2026-08-16
**Filed by:** the KAGO agent, on the owner's explicit instruction («заведи в KLAS баг»). The finding is
the owner's own — he asked *«кто сейчас открыл окно, проверь. Может это соседний агент?»* while a
NEIGHBOURING project was being blamed for it.

## Symptom

Every five minutes an empty `WindowsTerminal` window appears in the owner's OS and stays there. The
owner closed them by hand for hours and, understandably, blamed the project he was working in at the
time (KAGO). They were this task's.

Measured window creation times, matching this task's schedule to the second:

```
15:09:58 · 15:29:58 · 15:34:58 · 15:39:58 · 16:04:58
task \KLAS-gpu-watch: start 14:54:57, repeat every 5 min, last run 16:04:58
```

Forensics of one such window:

```
WindowsTerminal.exe -Embedding      · parent: svchost.exe -k DcomLaunch
child processes inside: 0           · title: «Администратор: …\powershell.exe»
```

## Root cause

The task's action is a **console-subsystem** program:

```xml
<Command>powershell.exe</Command>
<Arguments>-ExecutionPolicy Bypass -WindowStyle Hidden -File F:\KLAS\tools\gpu-watch.ps1</Arguments>
<LogonType>InteractiveToken</LogonType>
```

**`-WindowStyle Hidden` is not enough, and this is the whole defect.** That flag hides PowerShell's own
window; it does not remove PowerShell's need for a CONSOLE. On Windows 11 the *default terminal
application* setting hands that console to Windows Terminal, which the system starts through DCOM
(hence `-Embedding` and the `DcomLaunch` parent). PowerShell then finishes and exits — **and the
terminal window stays behind, empty**, because nothing owns it any more.

Every five minutes, forever, for as long as the owner is logged in.

## The fix applied

`tools/gpu-watch-launcher.js` (new) + the task's action changed to:

```
wscript.exe //B //E:JScript F:\KLAS\tools\gpu-watch-launcher.js
```

`wscript.exe` belongs to the **GUI subsystem**: it allocates no console at all, so nothing is handed to
the default terminal and no window can be left behind. The launcher starts the same PowerShell with
`WScript.Shell.Run(cmd, 0, false)` — window style 0 (fully hidden), no wait.

**Nothing else changes:** same script, same arguments, same interactive session, same user, same
schedule, same `ExecutionTimeLimit`.

## Why NOT the obvious fix («run whether user is logged on or not»)

That would move the task to session 0 and **break the observer by design**. `gpu-watch.ps1` documents
the reason in its own header:

> *«GetLastInputInfo reports the idle time of the CALLING session only. A service lives in session 0
> and would report its own idle time, never the owner's (researches/29, the trap). This script must
> run in the owner's interactive session.»*

So the interactive session is a REQUIREMENT of this component, not an oversight, and the fix had to
keep it. Recorded here because it is exactly the "obvious" correction a future session would make.

## Verification

- [ ] Next three ticks produce no new `WindowsTerminal` process.
- [ ] `logs/gpu-watch/*.jsonl` keeps receiving records — the observer still works.
- [ ] The idle-time field still reflects the OWNER's session, not zero.

Check: `tasklist /FI "IMAGENAME eq WindowsTerminal.exe"` after two ticks, and the journal's tail.

## Links

- `ideas/21` — the owner's requirement born from this incident (the process should live inside KLAS,
  in Docker, and never open terminal windows).
- KAGO `bugs/17` — the same symptom investigated from the other side; it also records the two
  leaks that genuinely belonged to KAGO and were fixed there.
