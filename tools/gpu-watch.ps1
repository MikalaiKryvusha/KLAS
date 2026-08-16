# gpu-watch.ps1 -- the OBSERVER of epic 26 (plans/28, phase 1). It watches and writes. It NEVER acts.
#
#   powershell -ExecutionPolicy Bypass -File F:\KLAS\tools\gpu-watch.ps1 -SelfTest
#   powershell -ExecutionPolicy Bypass -File F:\KLAS\tools\gpu-watch.ps1
#
# STOP SWITCH (one command, works even when started by Task Scheduler):
#   New-Item -ItemType File F:\KLAS\logs\gpu-watch\STOP
# The watcher notices the file within one tick, flushes its buffer and exits with code 0.
# It deletes the STOP file on exit, so the next start is clean.
#
# WHAT IT RECORDS: raw facts only, never verdicts (plans/28, design decision 2). Thresholds are
# replayed offline against this journal by tools/gpu-watch-replay.mjs, so a threshold change costs
# a rerun of the replay, not another day of waiting.
#
# WHY NOT A WINDOWS SERVICE: GetLastInputInfo reports the idle time of the CALLING session only.
# A service lives in session 0 and would report its own idle time, never the owner's
# (researches/29, the trap). This script must run in the owner's interactive session.
#
# SSD WEAR (owner's constraint 2026-08-16, rule R1 of plans/26): the card is polled every few
# seconds but the journal is only APPENDED on a state change, buffered in memory, and flushed to
# disk at most once per -FlushSec (plus on exit). A naive line-per-tick would be ~30 000 tiny
# writes a day.
#
# MEASURED COST (2026-08-16): one nvidia-smi query takes ~47 ms, two per tick at 3 s = ~3% of one
# core = ~0.19% of the machine.
#
# ASCII ONLY, ON PURPOSE. Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI (cp1251), and a
# mangled byte tears a quote and kills the parser mid-file -- symptom 9.6 in AGENT_GUIDE.md,
# lesson EXP-0066, guard: npm run guard:ps1

param(
  # How often the card is polled. Cheap; researches/29 calls 2-3 s appropriate for NVML.
  [int]$IntervalSec = 3,
  # A control line is written even when nothing changed, so gaps in the journal mean "watcher was
  # dead", not "nothing happened" (criterion F1-1 checks for gaps).
  [int]$HeartbeatMin = 5,
  # Upper bound on how long a recorded event may live in RAM only.
  [int]$FlushSec = 60,
  # How many consecutive polls a new state must hold before it is believed. At 3 s a poll this is
  # ~15 s of "yes, this is really happening" -- see the debounce comment below.
  [int]$ConfirmPolls = 5,
  # llama-swap is asked less often than the card: it is an HTTP round trip, and our own model
  # changes state rarely.
  [int]$KlasEverySec = 15,
  [string]$LogDir = 'F:\KLAS\logs\gpu-watch',
  # One poll, print every raw value, exit 0. This is step S2 of plans/28.
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# --- Thresholds that decide what counts as a CHANGE worth a journal line -----------------------
# They are deliberately coarse: the desktop jitters by tens of MiB and a few percent all day long,
# and every one of those jitters would otherwise cost a disk write.
$MEM_STEP_MIB  = 256   # a game or our model moves GiB, so 256 MiB is far below any real event
$UTIL_STEP_PCT = 20    # idle desktop jitters within ~10%
$IDLE_LEVELS   = @(60, 300, 900, 1800)  # seconds of owner idleness worth telling apart

# --- Win32: owner idleness and foreground window ------------------------------------------------
# GetLastInputInfo is the documented way to ask "is anybody at the keyboard"; it is per-session.
if (-not ('Klas.Win32' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Klas {
  public static class Win32 {
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO { public uint cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);

    public static int IdleSeconds() {
      LASTINPUTINFO lii = new LASTINPUTINFO();
      lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
      if (!GetLastInputInfo(ref lii)) { return -1; }
      // Both counters wrap after ~49.7 days; unsigned subtraction stays correct across the wrap.
      uint delta = unchecked(GetTickCount() - lii.dwTime);
      return (int)(delta / 1000);
    }

    public static int ForegroundPid() {
      IntPtr h = GetForegroundWindow();
      if (h == IntPtr.Zero) { return 0; }
      uint pid = 0;
      GetWindowThreadProcessId(h, out pid);
      return (int)pid;
    }

    // "Is the foreground window covering a whole monitor" -- the closest honest proxy for
    // "the owner is in a game or a full screen movie". Recorded as a RAW fact so that the
    // fullscreen-only rule of interviews/013 can be replayed offline instead of guessed at.
    public static bool ForegroundIsFullscreen() {
      IntPtr h = GetForegroundWindow();
      if (h == IntPtr.Zero) { return false; }
      RECT w;
      if (!GetWindowRect(h, out w)) { return false; }
      IntPtr mon = MonitorFromWindow(h, 2 /* MONITOR_DEFAULTTONEAREST */);
      if (mon == IntPtr.Zero) { return false; }
      MONITORINFO mi = new MONITORINFO();
      mi.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
      if (!GetMonitorInfo(mon, ref mi)) { return false; }
      RECT m = mi.rcMonitor;
      // A couple of pixels of slack: some players sit one pixel outside the monitor rect.
      return (w.left <= m.left + 2) && (w.top <= m.top + 2) &&
             (w.right >= m.right - 2) && (w.bottom >= m.bottom - 2);
    }
  }
}
'@
}

# --- Poll helpers -------------------------------------------------------------------------------

function Get-GpuSample {
  # One nvidia-smi call for the card-wide numbers. Per-process memory is NOT asked for on purpose:
  # on Windows WDDM nvidia-smi returns [N/A] for it (probed 2026-08-16), so only card totals exist.
  $raw = & nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu,utilization.memory,clocks.sm,power.draw,temperature.gpu --format=csv,noheader,nounits 2>$null
  if (-not $raw) { return $null }
  $f = ($raw | Select-Object -First 1).Split(',') | ForEach-Object { $_.Trim() }
  if ($f.Count -lt 7) { return $null }
  return [ordered]@{
    mem_used  = [int]$f[0]
    mem_total = [int]$f[1]
    util_gpu  = [int]$f[2]
    util_mem  = [int]$f[3]
    clk_sm    = [int]$f[4]
    pwr_w     = [double]$f[5]
    temp_c    = [int]$f[6]
  }
}

function Get-GpuProcesses {
  # Names only. Windows reports C+G (compute AND graphics) clients here, which is what we want:
  # a game shows up as a new name even though its memory reads [N/A].
  $raw = & nvidia-smi --query-compute-apps=pid,process_name --format=csv,noheader,nounits 2>$null
  $names = New-Object System.Collections.Generic.List[string]
  foreach ($line in @($raw)) {
    if (-not $line) { continue }
    $i = $line.IndexOf(',')
    if ($i -lt 0) { continue }
    $path = $line.Substring($i + 1).Trim()
    if (-not $path) { continue }
    $leaf = $path
    $slash = $path.LastIndexOf('\')
    if ($slash -ge 0) { $leaf = $path.Substring($slash + 1) }
    if (-not $names.Contains($leaf)) { $names.Add($leaf) | Out-Null }
  }
  $names.Sort()
  return ,$names.ToArray()
}

function Get-ForegroundName {
  $pid_ = [Klas.Win32]::ForegroundPid()
  if ($pid_ -le 0) { return '' }
  try { return (Get-Process -Id $pid_ -ErrorAction Stop).ProcessName } catch { return '' }
}

function Get-KlasRunning {
  # Which model llama-swap currently holds. Empty string = none loaded, "?" = llama-swap silent.
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/running' -TimeoutSec 2 -UseBasicParsing
    $j = $r.Content | ConvertFrom-Json
    if ($j.running -and $j.running.Count -gt 0) {
      return (@($j.running | ForEach-Object { $_.model }) -join ',')
    }
    return ''
  } catch { return '?' }
}

function Get-IdleLevel([int]$sec) {
  $lvl = 0
  foreach ($t in $IDLE_LEVELS) { if ($sec -ge $t) { $lvl++ } }
  return $lvl
}

function Get-Stamp { return (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') }

# --- Self-test (step S2): one poll, everything printed, exit 0 ----------------------------------
if ($SelfTest) {
  Write-Host 'gpu-watch self-test -- one poll of every sensor'
  $g = Get-GpuSample
  if (-not $g) { Write-Host 'FAIL: nvidia-smi gave no answer'; exit 1 }
  $procs = Get-GpuProcesses
  $idle = [Klas.Win32]::IdleSeconds()
  if ($idle -lt 0) { Write-Host 'FAIL: GetLastInputInfo failed'; exit 1 }
  Write-Host ("  time         : " + (Get-Stamp))
  Write-Host ("  memory       : {0} / {1} MiB used" -f $g.mem_used, $g.mem_total)
  Write-Host ("  utilization  : gpu {0}%  mem {1}%" -f $g.util_gpu, $g.util_mem)
  Write-Host ("  clocks / pwr : {0} MHz  {1} W  {2} C" -f $g.clk_sm, $g.pwr_w, $g.temp_c)
  Write-Host ("  owner idle   : {0} s (level {1})" -f $idle, (Get-IdleLevel $idle))
  Write-Host ("  foreground   : " + (Get-ForegroundName) + "  fullscreen: " + [Klas.Win32]::ForegroundIsFullscreen())
  Write-Host ("  klas model   : '" + (Get-KlasRunning) + "'  (empty = none loaded, ? = llama-swap silent)")
  Write-Host ("  gpu clients  : {0}" -f $procs.Count)
  foreach ($p in $procs) { Write-Host ("      " + $p) }
  Write-Host 'self-test OK'
  exit 0
}

# --- Journal ------------------------------------------------------------------------------------

# SURVIVE Ctrl-C. Paid for on the day this was written (bugs/27): the watcher kept dying after a few
# minutes with exit code 0xC000013A = STATUS_CONTROL_C_EXIT, every time the owner's session ran other
# console commands -- a console control event is broadcast to the whole process group attached to the
# console, and a long-running -File script takes it as "terminate". This flag turns Ctrl-C into plain
# input instead of a kill signal. It cannot save us from CTRL_CLOSE_EVENT, which is why the scheduled
# task ALSO repeats every 5 minutes: the flag is the cure, the repetition is the seatbelt.
try { [Console]::TreatControlCAsInput = $true } catch { }

# SINGLE INSTANCE. Two watchers would interleave lines in one journal, and a replay cannot tell
# the halves apart afterwards. A named mutex is the built-in way: it dies with the process, so
# there is no stale lock file to clean up after a crash or a reboot. (KLAS already paid for this
# class with the speakers -- tools/voice/single-instance.mjs.)
$mutexCreated = $false
$script:mutex = New-Object System.Threading.Mutex($true, 'Local\klas-gpu-watch', [ref]$mutexCreated)
if (-not $mutexCreated) {
  Write-Host 'Another gpu-watch is already running in this session -- refusing to start a second one.'
  Write-Host 'Stop it first:  New-Item -ItemType File F:\KLAS\logs\gpu-watch\STOP'
  exit 1
}

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$stopFile = Join-Path $LogDir 'STOP'
if (Test-Path $stopFile) { Remove-Item $stopFile -Force }

$buffer = New-Object System.Collections.Generic.List[string]
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Add-Event($obj) {
  # ConvertTo-Json in PS 5.1 escapes non-ASCII as \uXXXX, so a game in a Cyrillic folder cannot
  # smuggle a non-ASCII byte into the journal.
  $script:buffer.Add(($obj | ConvertTo-Json -Compress -Depth 4))
}

function Flush-Events {
  if ($script:buffer.Count -eq 0) { return }
  $path = Join-Path $LogDir ((Get-Date).ToString('yyyy-MM-dd') + '.jsonl')
  $text = ($script:buffer -join "`n") + "`n"
  [IO.File]::AppendAllText($path, $text, $script:utf8NoBom)
  $script:buffer.Clear()
}

# --- Main loop ----------------------------------------------------------------------------------

$lastMem = -99999
$lastUtil = -99999
$lastProcs = @()
$lastIdleLvl = -1
$lastKlas = 'init'
$lastFs = $null
$lastHb = [datetime]::MinValue
$lastFlush = Get-Date
$lastKlasPoll = [datetime]::MinValue
$klas = '?'
$ticks = 0

# Debounce state: a new reading becomes a journal line only after it has HELD for $ConfirmPolls
# polls. Paid for on the very first live run (2026-08-16): sdc_fma.exe appears and dies every ~10 s,
# each time pushing utilization to 54% for a few seconds, and the undebounced watcher wrote 38 lines
# in 5 minutes -- 2.7 MiB/day against the owner's 1 MiB budget. A watchdog acting on that signal
# would swing the model in and out all day long (risk "kacheli", criterion P5 of plans/26).
$candSig = ''
$candCount = 0
$candFirstSeen = $null

# Aggregates since the last written line. They exist so that debouncing does not DELETE the flapping
# from the record: a heartbeat still reports the peak and how many times the client set toggled.
$aggUtilMax = 0
$aggUtilSum = 0
$aggUtilN = 0
$aggMemMax = 0
$aggToggles = 0

function Reset-Agg {
  $script:aggUtilMax = 0; $script:aggUtilSum = 0; $script:aggUtilN = 0
  $script:aggMemMax = 0; $script:aggToggles = 0
}

try {
  while ($true) {
    if (Test-Path $stopFile) { break }
    $ticks++

    $g = Get-GpuSample
    if (-not $g) { Start-Sleep -Seconds $IntervalSec; continue }
    $procs = Get-GpuProcesses
    $idle = [Klas.Win32]::IdleSeconds()
    $idleLvl = Get-IdleLevel $idle
    $fs = [Klas.Win32]::ForegroundIsFullscreen()

    $now = Get-Date
    if (($now - $lastKlasPoll).TotalSeconds -ge $KlasEverySec) {
      $klas = Get-KlasRunning
      $lastKlasPoll = $now
    }

    # Running aggregates: they survive the debounce and travel on the next line written.
    $aggUtilMax = [math]::Max($aggUtilMax, $g.util_gpu)
    $aggUtilSum += $g.util_gpu
    $aggUtilN++
    $aggMemMax = [math]::Max($aggMemMax, $g.mem_used)

    $added   = @($procs | Where-Object { $lastProcs -notcontains $_ })
    $removed = @($lastProcs | Where-Object { $procs -notcontains $_ })

    $why = New-Object System.Collections.Generic.List[string]
    if ([math]::Abs($g.mem_used - $lastMem) -ge $MEM_STEP_MIB) { $why.Add('mem') }
    if ([math]::Abs($g.util_gpu - $lastUtil) -ge $UTIL_STEP_PCT) { $why.Add('util') }
    if ($added.Count -gt 0 -or $removed.Count -gt 0) { $why.Add('procs') }
    if ($idleLvl -ne $lastIdleLvl) { $why.Add('idle') }
    if ($klas -ne $lastKlas) { $why.Add('klas') }
    # Going fullscreen IS worth a line (a game or a movie starts), unlike plain alt-tabbing.
    if ($fs -ne $lastFs) { $why.Add('fs') }

    # The signature is coarse ON PURPOSE: it is what "the state of the card" means to this epic.
    # Two readings with the same signature are the same situation, however the raw numbers jitter.
    $sig = '{0}|{1}|{2}|{3}|{4}|{5}' -f `
      [math]::Floor($g.mem_used / $MEM_STEP_MIB), [math]::Floor($g.util_gpu / $UTIL_STEP_PCT), `
      ($procs -join ','), $idleLvl, $klas, $fs

    $isFirst = ($ticks -eq 1)
    $isHb = (($now - $lastHb).TotalMinutes -ge $HeartbeatMin)

    # Confirm the candidate before believing it.
    $confirmed = $false
    if ($why.Count -gt 0) {
      if ($sig -eq $candSig) {
        $candCount++
      } else {
        $candSig = $sig
        $candCount = 1
        $candFirstSeen = $now
        if ($added.Count -gt 0 -or $removed.Count -gt 0) { $aggToggles++ }
      }
      if ($candCount -ge $ConfirmPolls) { $confirmed = $true }
    } else {
      # Back to the last logged state: whatever was flapping did not stick.
      $candSig = ''
      $candCount = 0
    }

    if ($isFirst -or $isHb -or $confirmed) {
      $ev = 'change'
      if ($isFirst) { $ev = 'start'; $why.Clear() } elseif (-not $confirmed) { $ev = 'hb' }

      $rec = [ordered]@{
        ts        = Get-Stamp
        ev        = $ev
        why       = @($why)
        mem_used  = $g.mem_used
        mem_free  = ($g.mem_total - $g.mem_used)
        util_gpu  = $g.util_gpu
        util_mem  = $g.util_mem
        clk_sm    = $g.clk_sm
        pwr_w     = $g.pwr_w
        temp_c    = $g.temp_c
        idle_s    = $idle
        # The foreground app never TRIGGERS a line by itself -- alt-tabbing all day would cost
        # hundreds of writes and buy nothing. It rides along on lines written for other reasons.
        fg        = (Get-ForegroundName)
        fs        = $fs
        klas      = $klas
        nproc     = $procs.Count
        # What happened BETWEEN the lines. Without these three the debounce would quietly erase a
        # flapping consumer from the record, and the replay would see a calm day that never was.
        util_max  = $aggUtilMax
        util_avg  = [math]::Round($aggUtilSum / [math]::Max($aggUtilN, 1), 1)
        toggles   = $aggToggles
      }
      # When the line is a confirmed change, say when the new state was FIRST seen: the confirmation
      # delay is ours, and a replay measuring reaction time must not be charged for it.
      if ($confirmed -and $candFirstSeen) { $rec.first_seen = $candFirstSeen.ToString('yyyy-MM-ddTHH:mm:sszzz') }
      # The full client list is heavy (~27 names here), so it is written once at start; after that
      # only the delta travels, which is what a replay needs to rebuild the set anyway.
      if ($isFirst) {
        $rec.procs = @($procs)
      } else {
        # On the first line the whole set IS the delta, and repeating it there doubled the line.
        if ($added.Count -gt 0) { $rec.added = @($added) }
        if ($removed.Count -gt 0) { $rec.removed = @($removed) }
      }

      Add-Event $rec
      $lastMem = $g.mem_used
      $lastUtil = $g.util_gpu
      $lastProcs = $procs
      $lastIdleLvl = $idleLvl
      $lastKlas = $klas
      $lastFs = $fs
      $lastHb = $now
      $candSig = ''
      $candCount = 0
      Reset-Agg
    }

    if (($now - $lastFlush).TotalSeconds -ge $FlushSec) {
      Flush-Events
      $lastFlush = $now
    }

    Start-Sleep -Seconds $IntervalSec
  }

  Add-Event ([ordered]@{ ts = (Get-Stamp); ev = 'stop'; why = @('stopfile') })
}
finally {
  Flush-Events
  if (Test-Path $stopFile) { Remove-Item $stopFile -Force -ErrorAction SilentlyContinue }
  if ($script:mutex) { $script:mutex.ReleaseMutex(); $script:mutex.Dispose() }
}
