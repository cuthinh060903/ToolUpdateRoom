param(
  [string]$RepoRoot,
  [string]$EntryScript = "scripts/run-all-daily.js",
  [string]$LogDir = "logs",
  [string]$LogPrefix = "all-run",
  [int]$LogRetentionDays = 3,
  [ValidateSet("manual", "scheduler")]
  [string]$RunSource = "scheduler",
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
$lockDir = Join-Path $resolvedLogDir ".locks"
New-Item -ItemType Directory -Force -Path $lockDir | Out-Null
$activeRunInfoPath = Join-Path $lockDir "active-run.json"

if ([string]::IsNullOrWhiteSpace($LogPrefix)) {
  $LogPrefix = "all-run"
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

function Normalize-EntryScriptPath([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) {
    return ""
  }

  return ($value.Trim() -replace "\\", "/").ToLower()
}

function Test-HasArgPrefix([string[]]$ArgsToCheck, [string[]]$Prefixes) {
  if (-not $ArgsToCheck -or -not $Prefixes) {
    return $false
  }

  foreach ($argItem in $ArgsToCheck) {
    $normalizedArg = ($argItem.ToString().Trim()).ToLower()
    foreach ($prefix in $Prefixes) {
      $normalizedPrefix = ($prefix.ToString().Trim()).ToLower()
      if ($normalizedArg.StartsWith($normalizedPrefix)) {
        return $true
      }
    }
  }

  return $false
}

function Get-ActiveRunInfo([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    $raw = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) {
      return $null
    }
    return ($raw | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    return $null
  }
}

function Test-IsFullScopeManualCommand([string]$normalizedEntryScript, [string[]]$manualScriptArgs) {
  $hasMainOnlyIdsEnv = -not [string]::IsNullOrWhiteSpace($env:RUN_ONLY_IDS)
  $hasAuditOnlyIdsEnv = -not [string]::IsNullOrWhiteSpace($env:ROOM_AUDIT_ONLY_IDS)
  $hasAuditErrorsEnv = -not [string]::IsNullOrWhiteSpace($env:ROOM_AUDIT_TEST_ERRORS)
  $hasAuditLimitEnv = -not [string]::IsNullOrWhiteSpace($env:ROOM_AUDIT_LIMIT)

  if ($normalizedEntryScript -eq "index.js") {
    return -not $hasMainOnlyIdsEnv
  }

  if ($normalizedEntryScript -eq "modules/room-audit/index.js") {
    $hasAuditFilterArg = Test-HasArgPrefix $manualScriptArgs @("--ids=", "--test-errors=", "--limit=")
    return (-not $hasAuditFilterArg) -and (-not $hasAuditOnlyIdsEnv) -and (-not $hasAuditErrorsEnv) -and (-not $hasAuditLimitEnv)
  }

  if ($normalizedEntryScript -eq "scripts/run-all-daily.js") {
    $hasCombinedFilterArg = Test-HasArgPrefix $manualScriptArgs @(
      "--skip-all",
      "--skip-main",
      "--skip-room-audit",
      "--room-audit-ids=",
      "--room-audit-limit=",
      "--room-audit-test-errors=",
      "--room-audit-use-api=",
      "--room-audit-debug="
    )

    return (-not $hasCombinedFilterArg) -and (-not $hasMainOnlyIdsEnv) -and (-not $hasAuditOnlyIdsEnv) -and (-not $hasAuditErrorsEnv) -and (-not $hasAuditLimitEnv)
  }

  return $false
}

$normalizedEntryScript = Normalize-EntryScriptPath $EntryScript

Write-Host "[scheduler] Repo root: $RepoRoot"
Write-Host "[scheduler] Entry script: $EntryScript"
Write-Host "[scheduler] Log file: $logFile"
Write-Host "[scheduler] Run source: $RunSource"
if ($ScriptArgs.Count -gt 0) {
  Write-Host "[scheduler] Script args: $($ScriptArgs -join ' ')"
}

$nodeVersionOutput = (& $nodeCommand.Source --version 2>$null)
if ($nodeVersionOutput -match "^v(\d+)") {
  $nodeMajorVersion = [int]$Matches[1]
  if ($nodeMajorVersion -ge 23) {
    $nodeWarning = "[scheduler] WARNING: Detected Node.js $nodeVersionOutput. Runtime crash 0xC0000409 has been observed on some Windows setups with newer Node builds. Prefer Node.js 20/22 LTS for scheduler stability."
    Write-Host $nodeWarning
    Add-Content -Path $logFile -Value $nodeWarning
  }
}

$mutexName = $env.TOOLUPDATEROOM_MUTEX_NAME
if ([string]::IsNullOrWhiteSpace($mutexName)) {
  $mutexName = "Global\ToolUpdateRoom-Run-Lock"
}

$runMutex = $null
$hasRunMutex = $false
$allowManualScopedRunWithoutMutex = $false
$createdActiveRunInfo = $false
try {
  $createdNew = $false
  $runMutex = New-Object System.Threading.Mutex($false, $mutexName, [ref]$createdNew)
  $hasRunMutex = $runMutex.WaitOne(0)
} catch {
  $mutexError = "[scheduler] WARNING: Failed to initialize run mutex '$mutexName'. Continue without cross-task lock. Error: $($_.Exception.Message)"
  Write-Warning $mutexError
  Add-Content -Path $logFile -Value $mutexError
}

if (-not $hasRunMutex) {
  $activeRunInfo = Get-ActiveRunInfo $activeRunInfoPath
  $activeRunSource = ""
  if ($null -ne $activeRunInfo -and $null -ne $activeRunInfo.runSource) {
    $activeRunSource = $activeRunInfo.runSource.ToString().Trim().ToLower()
  }
  $isFullScopeManualCommand =
    ($RunSource -eq "manual") -and
    (Test-IsFullScopeManualCommand $normalizedEntryScript $ScriptArgs)

  if ($isFullScopeManualCommand -and $activeRunSource -eq "scheduler") {
    $skipMessage = "[scheduler] Khong chay lenh tay vi luong daily dang chay theo lich da cai. Vui long doi luot daily hien tai hoan thanh de tranh xung dot."
  } elseif (
    ($RunSource -eq "manual") -and
    (-not $isFullScopeManualCommand) -and
    ($activeRunSource -eq "scheduler")
  ) {
    $allowManualScopedRunWithoutMutex = $true
    Write-Host "[scheduler] Daily dang chay, nhung lenh tay scope nho duoc phep chay song song."
    Add-Content -Path $logFile -Value "[scheduler] Daily dang chay, cho phep lenh tay scope nho chay song song (khong khoa mutex)."
  } else {
    $skipMessage = "[scheduler] Skipped trigger because another ToolUpdateRoom run is still active (mutex=$mutexName)."
  }

  if (-not $allowManualScopedRunWithoutMutex) {
    Write-Host $skipMessage
    Add-Content -Path $logFile -Value $skipMessage
    if ($runMutex) {
      $runMutex.Dispose()
    }
    return
  }

  if ($runMutex) {
    $runMutex.Dispose()
    $runMutex = $null
  }
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

try {
  $env:TOOL_RUN_SOURCE = $RunSource
  $env:TOOL_RUN_CONTEXT = if ($RunSource -eq "scheduler") { "daily" } else { "manual" }
  $env:RUN_CONTEXT = $env:TOOL_RUN_CONTEXT

  if ($hasRunMutex) {
    $activeRunInfoPayload = [ordered]@{
      runSource = $RunSource
      runContext = $env:TOOL_RUN_CONTEXT
      entryScript = $EntryScript
      startedAt = (Get-Date).ToString("o")
      pid = $PID
      scriptArgs = $ScriptArgs
    } | ConvertTo-Json -Depth 4
    Set-Content -LiteralPath $activeRunInfoPath -Value $activeRunInfoPayload -Encoding UTF8
    $createdActiveRunInfo = $true
  }

  $nativeCommand = ($commandParts -join " ") + " >> " + (Quote-CmdArgument $logFile) + " 2>&1"
  & cmd.exe /d /c $nativeCommand
  $exitCode = $LASTEXITCODE

  Add-Content -Path $logFile -Value ""
  Add-Content -Path $logFile -Value "[scheduler] Exit code: $exitCode"

  if ($exitCode -eq -1073740791) {
    Add-Content -Path $logFile -Value "[scheduler] Detected STATUS_STACK_BUFFER_OVERRUN (0xC0000409). This is a process-level crash (often native/runtime abort), not a normal JS exception."
  }

  if ($exitCode -ne 0) {
    throw "Tool exited with code $exitCode. See log: $logFile"
  }

  Write-Host "[scheduler] Run completed successfully."
} finally {
  if ($createdActiveRunInfo -and (Test-Path -LiteralPath $activeRunInfoPath)) {
    Remove-Item -LiteralPath $activeRunInfoPath -Force -ErrorAction SilentlyContinue
  }

  if ($hasRunMutex -and $runMutex) {
    try {
      [void]$runMutex.ReleaseMutex()
    } catch {
      Write-Warning "[scheduler] Failed to release mutex '$mutexName': $($_.Exception.Message)"
    } finally {
      $runMutex.Dispose()
    }
  }
}
