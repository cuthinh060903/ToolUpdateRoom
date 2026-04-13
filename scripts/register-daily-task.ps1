param(
  [string]$TaskName = "ToolUpdateRoom-Daily",
  [Alias("Time")]
  [string[]]$Times = @("05:00"),
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$EntryScript = "index.js"
)

$ErrorActionPreference = "Stop"

$runScriptPath = Join-Path $PSScriptRoot "run-daily.ps1"
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
  "-File", ('"{0}"' -f $runScriptPath)
  "-RepoRoot", ('"{0}"' -f $RepoRoot)
  "-EntryScript", ('"{0}"' -f $EntryScript)
) -join " "

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
