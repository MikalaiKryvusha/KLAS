# Bug 29 — the tray balloon re-appears whenever the OS wants to show ANY notification

**Status:** 🔧 fix applied, awaiting verification · **cause NOT established, and the fix does not
depend on establishing it**
**Version/build:** `main` @ the state of 2026-08-23 · **When/context:** found by the OWNER, 2026-08-23
**Filed by:** the KAGO agent, on the owner's explicit instruction («сможешь посмотреть и починить?»).
The neighbour rule was kept in the way that matters: nothing here was guessed at, the change is
recorded in this project rather than left silent, and a rollback copy of the original file exists.

The owner, verbatim:

> *«и ещё в KLAS проекте есть какой-то баг. Словно всякий раз, когда ОС какую-либо пуш-нотификацию
> показать хочет — это тригерит показ нотификации KLAS — это баг»*

## Symptom

The KLAS tray notification («KLAS запущен и работает») shows up again long after startup, seemingly
every time some other application posts a notification.

## Where it comes from

`tools/klas.ps1`, the `tray` action. One call, and it is the ONLY notification this project emits:

```powershell
$notify.ShowBalloonTip(5000, 'KLAS', $balloon, [System.Windows.Forms.ToolTipIcon]::None)
```

A grep over the whole of `tools/` finds no second producer, and `gpu-watch.ps1` — the only thing that
runs repeatedly (every five minutes) — does not touch notifications at all.

## Forensics — and the theory it REFUTED

The obvious first theory was «the toast is stuck in the Action Center and gets re-rendered». It was
tested before being believed, and it is **wrong**:

| check | result |
|---|---|
| `wpndatabase.db` (the Windows notification store) searched for `KLAS` | **0 occurrences** |
| KLAS's `powershell.exe` among the registered notification sources (`HKCU\…\Notifications\Settings`) | **absent** |

So this is not a modern toast lingering in the Action Center. It is the LEGACY tray-balloon path
(`Shell_NotifyIcon` with `NIF_INFO`), which never enters that store — consistent with what was
measured.

## Root cause — NOT ESTABLISHED, and that is written on purpose

What the mechanism actually is — why another application's notification brings this one back — was
not caught by observation. Microsoft documents an adjacent fact that makes a shell-side QUEUE
plausible: *only one balloon tip can be displayed at a time, and attempting to show one while
another is displayed causes the timeout value to be ignored.* That is a hypothesis, not a finding.

**Why no fourth plausible story is offered here:** the agent filing this has already paid for that
habit on this owner's machine — `bugs/17` in the neighbouring project records three consecutive
confident diagnoses, all refuted, and three complaints from the owner as the price.

## Fix applied

**The success notification is removed; only FAILURE notifies.**

```powershell
Start-KlasStack
if (-not $script:DockerUp) {
    $notify.ShowBalloonTip(5000, 'KLAS', 'KLAS поднят ЧАСТИЧНО: docker-стек не стартовал — запусти Docker Desktop', …)
}
```

**The reasoning, since the fix deliberately sidesteps the unknown mechanism:** on the normal path
there is now no notification at all, so no queue, no re-show, whatever the trigger turns out to be.
Nothing is lost — the tray icon appearing IS the statement that KLAS came up. The failure case keeps
its notification, because that is information the owner must not miss and it is rare.

The file's own header was corrected in the same change: it still advertised «пуш "KLAS запущен и
работает"», i.e. it described behaviour that no longer exists.

## Verification performed

- PowerShell parsed the patched file with **0 errors** (parse only, not executed).
- `node tools/ps1-encoding-guard.mjs` — **10 files checked, 0 defects, exit 0**. This mattered: the
  file is UTF-8 **with BOM** and carries 2 531 Cyrillic characters, so it was patched through Node
  with the BOM written back explicitly, never through a shell editor.
- The failure string reads back intact from disk.
- **NOT verified:** that the re-showing has actually stopped. That needs the owner's eyes over the
  next days, and it needs the tray to be restarted (the running instance still holds the old script).

## Rollback

The original file is copied to `D:\work\ai_sandbox\KAGO\runs\shell\rollback\klas.ps1.BEFORE`.
Restoring it is a file copy.

## Decisions made without the owner

- **The failure notification was KEPT while the success one was removed.** The owner asked to remove
  «уведомление об успешном старте»; treating the docker-failure message as the same thing would have
  silenced the one message that actually carries information.
- **The cause is recorded as NOT ESTABLISHED rather than as the queue hypothesis.**
- **Only `klas.ps1` was touched.** No task, no schedule, no other file in this project.

## Links

- `bugs/28` — the other defect of this project's shell surface found by the owner on the same
  machine, also filed from the neighbouring project.
- Neighbouring project's `bugs/17` — why this document refuses to name a cause it cannot show.
- Microsoft, `NotifyIcon.ShowBalloonTip`: https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.notifyicon.showballoontip
