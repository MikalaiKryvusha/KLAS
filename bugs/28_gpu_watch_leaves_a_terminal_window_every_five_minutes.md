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

- [x] Next three ticks produce no new `WindowsTerminal` process.
- [x] `logs/gpu-watch/*.jsonl` keeps receiving records — the observer still works.
- [x] The idle-time field still reflects the OWNER's session, not zero.

Check: `tasklist /FI "IMAGENAME eq WindowsTerminal.exe"` after two ticks, and the journal's tail.

---

## ✅ ПРОВЕРЕНО И ЗАКРЫТО — 2026-08-16, агент проекта KLAS

Владелец потребовал не переводить документ, а работать по нему («надо РАБОТАТЬ ПО НЕМУ И ФИКСИТЬ»).
Ниже — что реально наблюдалось, а не что ожидалось.

**Заплатка соседнего агента (`wscript` вместо `powershell`) держит.** Через несколько часов и
десятки тиков расписания:

```
Get-Process WindowsTerminal        → 0 процессов
Get-ScheduledTaskInfo KLAS-gpu-watch → последний запуск 21:04:58, результат 0
tail logs/gpu-watch/2026-08-16.jsonl → записи идут, idle_s = 0..1 (сеанс ВЛАДЕЛЬЦА, не нуль-заглушка)
```

**Корень вылечен переездом, а не заплаткой.** Требование владельца из `ideas/21` исполнено:
наблюдатель теперь сервис докера `gpu-manager` внутри стека KLAS (`docker-compose.yml`,
код — `tools/gpu-manager.mjs`). У контейнера **нет консоли вообще**, поэтому «терминал по
умолчанию» Windows нечего ему выдавать — окно не может появиться ни при каких настройках ОС.
Это сильнее заплатки: `wscript` убирает консоль у ОДНОГО способа запуска, контейнер убирает саму
возможность.

**Что осталось от хостового датчика и почему.** `tools/gpu-watch.ps1` под задачей
`KLAS-gpu-watch` продолжает работать до закрытия фазы 1 — он ЕДИНСТВЕННЫЙ источник величины «окно
во весь экран», без которой нельзя судить правила C и C+B отбора эпика 26. Он больше не открывает
окон (та же заплатка `wscript`). Правило выбрано → задача снимается совсем:
`Unregister-ScheduledTask KLAS-gpu-watch`.

**Класс дефекта, который стоит помнить:** «скрыть окно» и «не иметь консоли» — разные вещи.
`-WindowStyle Hidden` прячет окно самого PowerShell, но не отменяет его потребность в КОНСОЛИ, а
консоль на Windows 11 выдаёт Windows Terminal через DCOM — и она переживает породивший её процесс.
Лечится сменой подсистемы (GUI вместо консольной) или уходом туда, где консоли нет вовсе.

## Links

- `ideas/21` — the owner's requirement born from this incident (the process should live inside KLAS,
  in Docker, and never open terminal windows).
- KAGO `bugs/17` — the same symptom investigated from the other side; it also records the two
  leaks that genuinely belonged to KAGO and were fixed there.
