param(
  [string]$TaskName = "ToolUpdateRoom-TwiceDaily"
)

$ErrorActionPreference = "Stop"

$queryOutput = & schtasks /Query /TN $TaskName 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Scheduled task '$TaskName' was not found."
}

$endOutput = & schtasks /End /TN $TaskName 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Failed to stop scheduled task '$TaskName'. Details: $($endOutput -join ' ')"
}

Write-Host "[scheduler] Stop requested for task '$TaskName'."
