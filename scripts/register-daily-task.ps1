param(
  [string]$TaskName = "ToolUpdateRoom-All-Daily",
  [Alias("Time")]
  [string[]]$Times = @("05:00"),
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$EntryScript = "scripts/run-all-daily.js",
  [string]$LogPrefix = "all-run",
  [string[]]$ScriptArgs = @()
)

$ErrorActionPreference = "Stop"

$runScriptPath = Join-Path $PSScriptRoot "run-daily.ps1"
$combinedEntryScript = "scripts/run-all-daily.js"

$entryScriptText = ""
if ($null -ne $EntryScript) {
  $entryScriptText = $EntryScript.ToString()
}
$normalizedEntryScript = ($entryScriptText.Trim() -replace "\\", "/").ToLower()
if ($normalizedEntryScript -ne $combinedEntryScript.ToLower()) {
  Write-Warning "[scheduler] Auto schedule is forced to combined flow (trong-kin -> room-audit). Overriding EntryScript '$EntryScript' -> '$combinedEntryScript'."
  $EntryScript = $combinedEntryScript
}

if ([string]::IsNullOrWhiteSpace($LogPrefix) -or $LogPrefix -in @("daily-run", "trong-kin-run", "room-audit-run")) {
  $LogPrefix = "all-run"
}

function Quote-PowerShellArgument([string]$value) {
  if ($null -eq $value) {
    return '""'
  }

  return '"' + $value.Replace('"', '""') + '"'
}

$normalizedTimes = @()
foreach ($timeValue in $Times) {
  if ([string]::IsNullOrWhiteSpace($timeValue)) {
    continue
  }

  $normalizedTimes += $timeValue.Split(",") |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ }
}

$normalizedTimes = $normalizedTimes | Select-Object -Unique
if ($normalizedTimes.Count -eq 0) {
  throw "At least one schedule time is required. Example: -Times '12:00','17:30'"
}

$actionArgs = @(
  "-NoProfile"
  "-ExecutionPolicy", "Bypass"
  "-File", (Quote-PowerShellArgument $runScriptPath)
  "-RepoRoot", (Quote-PowerShellArgument $RepoRoot)
  "-EntryScript", (Quote-PowerShellArgument $EntryScript)
  "-LogPrefix", (Quote-PowerShellArgument $LogPrefix)
) -join " "

if ($ScriptArgs.Count -gt 0) {
  $actionArgs += " -ScriptArgs " + (($ScriptArgs | ForEach-Object {
        Quote-PowerShellArgument $_
      }) -join " ")
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument $actionArgs

$triggers = foreach ($normalizedTime in $normalizedTimes) {
  $runTime = [DateTime]::ParseExact($normalizedTime, "HH:mm", $null)
  New-ScheduledTaskTrigger -Daily -At $runTime
}

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Description "Run ToolUpdateRoom automatically every day." `
  -Force | Out-Null

Write-Host "[scheduler] Registered task '$TaskName' at $($normalizedTimes -join ', ')."
Write-Host "[scheduler] Repo root: $RepoRoot"
Write-Host "[scheduler] Entry script: $EntryScript"
if ($ScriptArgs.Count -gt 0) {
  Write-Host "[scheduler] Script args: $($ScriptArgs -join ' ')"
}
