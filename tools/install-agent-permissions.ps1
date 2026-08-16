# install-agent-permissions.ps1 -- widen the agent's permissions in KLAS.
#
# Owner runs this; the agent writes it but never applies it.
#   powershell -ExecutionPolicy Bypass -File F:\KLAS\tools\install-agent-permissions.ps1
#   powershell -ExecutionPolicy Bypass -File F:\KLAS\tools\install-agent-permissions.ps1 -Rollback
#
# Writes the "permissions" block into F:\KLAS\.claude\settings.local.json (local, gitignored).
# The previous file is kept next to it as .bak-<timestamp>.
#
#   defaultMode = bypassPermissions  -- the agent asks nothing about commands
#   ask   = []                       -- empty, by the owner's word (2026-08-16)
#   deny  = [...]                    -- only explicitly destructive commands remain
# Deny rules apply EVEN in bypassPermissions mode -- that is the only remaining brake.
#
# Restart Claude Code after installing: settings are read at session start.
# Verify inside Claude Code with the /permissions command.
#
# ASCII ONLY, ON PURPOSE. This file is read by Windows PowerShell 5.1, which decodes a .ps1
# without a BOM as ANSI (cp1251). Cyrillic here breaks not only the output but the CODE:
# a mangled byte tears a quote and the parser dies mid-file. Paid for on 2026-08-16 --
# symptom 9.6 in AGENT_GUIDE.md, lesson EXP-0066, guard: npm run guard:ps1

param([switch]$Rollback)

$ErrorActionPreference = 'Stop'

$dir = 'F:\KLAS\.claude'
$dst = Join-Path $dir 'settings.local.json'

if ($Rollback) {
  $bak = Get-ChildItem "$dst.bak-*" -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
  if (-not $bak) { Write-Host "No backup found next to $dst -- nothing to roll back."; exit 1 }
  Copy-Item $bak.FullName $dst -Force
  Write-Host "Rolled back from: $($bak.Name)"
  Write-Host "Restart Claude Code for it to take effect."
  exit 0
}

$permissions = [ordered]@{
  permissions = [ordered]@{
    defaultMode = 'bypassPermissions'
    ask         = @()
    allow       = @(
      'Bash(*)', 'PowerShell(*)', 'Read(//**)',
      'Write(//F:/KLAS/**)', 'Edit(//F:/KLAS/**)',
      'WebFetch', 'WebSearch'
    )
    deny        = @(
      'Bash(rm -rf /*)', 'Bash(rm -rf ~*)', 'Bash(mkfs*)', 'Bash(dd if=*of=/dev/*)',
      'Bash(shutdown*)', 'Bash(reboot*)',
      'Bash(git push --force*)', 'Bash(git push -f*)',
      'Bash(git reset --hard*)', 'Bash(git clean -fdx*)',
      'Bash(curl*|*sh)', 'Bash(wget*|*sh)',
      'PowerShell(Format-Volume*)', 'PowerShell(Clear-Disk*)', 'PowerShell(Initialize-Disk*)',
      'PowerShell(Stop-Computer*)', 'PowerShell(Restart-Computer*)',
      'PowerShell(Set-MpPreference*)', 'PowerShell(Add-MpPreference*)',
      'PowerShell(Remove-LocalUser*)', 'PowerShell(Set-ExecutionPolicy*)',
      'Read(//**/.env)', 'Read(//**/id_rsa*)',
      'Write(//C:/Windows/**)', 'Write(//**/.git/**)'
    )
  }
}

if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

if (Test-Path $dst) {
  $bak = "$dst.bak-" + (Get-Date -Format 'yyyy-MM-dd-HHmmss')
  Copy-Item $dst $bak -Force
  Write-Host "Backup of previous settings: $bak"
}

# WriteAllText with UTF8Encoding($false) -- JSON without BOM, some parsers choke on a BOM.
$json = $permissions | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText($dst, $json, (New-Object Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "OK -- permissions installed: $dst"
Write-Host ""
Get-Content $dst
Write-Host ""
Write-Host "Now restart Claude Code. Verify inside it with: /permissions"
Write-Host "Roll back with: -Rollback"
