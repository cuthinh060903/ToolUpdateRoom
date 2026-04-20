param(
  [string]$RepoRoot,
  [string]$EntryScript = "index.js",
  [string]$LogDir = "logs",
  [string]$LogPrefix = "daily-run",
  [int]$LogRetentionDays = 3,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ScriptArgs
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
  $RepoRoot = (Resolve-Path (Join-Path $scriptDirectory "..")).Path
}

Set-Location $RepoRoot

$resolvedLogDir = Join-Path $RepoRoot $LogDir
New-Item -ItemType Directory -Force -Path $resolvedLogDir | Out-Null

if ([string]::IsNullOrWhiteSpace($LogPrefix)) {
  $LogPrefix = "daily-run"
}

$invalidFileNameChars = [System.IO.Path]::GetInvalidFileNameChars()
foreach ($invalidChar in $invalidFileNameChars) {
  $LogPrefix = $LogPrefix.Replace($invalidChar, "-")
}

if (
  -not $PSBoundParameters.ContainsKey("LogRetentionDays") -and
  -not [string]::IsNullOrWhiteSpace($env.LOG_RETENTION_DAYS)
) {
  $envRetentionDays = 0
  if ([int]::TryParse($env.LOG_RETENTION_DAYS, [ref]$envRetentionDays)) {
    $LogRetentionDays = $envRetentionDays
  }
}

$safeLogRetentionDays = if ($LogRetentionDays -ge 1) { $LogRetentionDays } else { 1 }
$cutoffDate = (Get-Date).Date.AddDays(-($safeLogRetentionDays - 1))
$logPattern = "*.log"
$logsToDelete = Get-ChildItem -Path $resolvedLogDir -Filter $logPattern -File -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime.Date -lt $cutoffDate }

if ($logsToDelete) {
  foreach ($oldLog in $logsToDelete) {
    Remove-Item -LiteralPath $oldLog.FullName -Force
  }
  Write-Host "[scheduler] Removed old logs: $($logsToDelete.Count) (retention=$safeLogRetentionDays day(s), pattern=$logPattern)"
}

$timestamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$logFile = Join-Path $resolvedLogDir "$LogPrefix-$timestamp.log"
$nodeCommand = Get-Command node -ErrorAction Stop

Write-Host "[scheduler] Repo root: $RepoRoot"
Write-Host "[scheduler] Entry script: $EntryScript"
Write-Host "[scheduler] Log file: $logFile"
if ($ScriptArgs.Count -gt 0) {
  Write-Host "[scheduler] Script args: $($ScriptArgs -join ' ')"
}

function Quote-CmdArgument([string]$value) {
  if ($null -eq $value) {
    return '""'
  }

  $escapedValue = $value.Replace('"', '\"')
  return '"' + $escapedValue + '"'
}

$commandParts = @(
  (Quote-CmdArgument $nodeCommand.Source),
  (Quote-CmdArgument $EntryScript)
)

if ($ScriptArgs) {
  $commandParts += $ScriptArgs | ForEach-Object { Quote-CmdArgument $_ }
}

$nativeCommand = ($commandParts -join " ") + " >> " + (Quote-CmdArgument $logFile) + " 2>&1"
& cmd.exe /d /c $nativeCommand
$exitCode = $LASTEXITCODE

Add-Content -Path $logFile -Value ""
Add-Content -Path $logFile -Value "[scheduler] Exit code: $exitCode"

if ($exitCode -ne 0) {
  throw "Tool exited with code $exitCode. See log: $logFile"
}

Write-Host "[scheduler] Run completed successfully."
