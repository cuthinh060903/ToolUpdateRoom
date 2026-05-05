param(
  [string]$TaskName = "ToolUpdateRoom-All-Daily",
  [Alias("Time")]
  [string[]]$Times = @("05:00"),
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$EntryScript = "scripts/run-all-daily.js",
  [string]$LogPrefix = "all-run",
  [string[]]$ScriptArgs = @(),
  [switch]$DisableLegacyTasks = $true
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

function Disable-TaskIfExists([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name)) {
    return
  }

  $previousErrorActionPreference = $ErrorActionPreference
  $hadNativePreference = $null -ne (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue)
  if ($hadNativePreference) {
    $previousNativePreference = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
  }

  $queryExitCode = 0
  try {
    $ErrorActionPreference = "Continue"
    & schtasks /Query /TN $Name *> $null
    $queryExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($hadNativePreference) {
      $PSNativeCommandUseErrorActionPreference = $previousNativePreference
    }
  }

  if ($queryExitCode -ne 0) {
    return
  }

  & schtasks /End /TN $Name *> $null
  & schtasks /Change /TN $Name /Disable *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Warning "[scheduler] Disabled legacy task '$Name' to prevent overlap with combined flow."
  } else {
    Write-Warning "[scheduler] Found legacy task '$Name' but failed to disable it."
  }
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
  "-RunSource", (Quote-PowerShellArgument "scheduler")
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

if ($DisableLegacyTasks -and $TaskName -eq "ToolUpdateRoom-All-Daily") {
  @(
    "ToolUpdateRoom-TrongKin-Daily",
    "ToolUpdateRoom-RoomAudit-Daily",
    "ToolUpdateRoom-TwiceDaily"
  ) | ForEach-Object {
    if ($_ -ne $TaskName) {
      Disable-TaskIfExists $_
    }
  }
}
