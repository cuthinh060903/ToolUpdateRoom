param(
  [Parameter(Mandatory = $true)]
  [string]$TaskName
)

$ErrorActionPreference = "Stop"

$queryOutput = & schtasks /Query /TN $TaskName 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Scheduled task '$TaskName' was not found."
}

$deleteOutput = & schtasks /Delete /TN $TaskName /F 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "Failed to delete scheduled task '$TaskName'. Details: $($deleteOutput -join ' ')"
}

Write-Host "[scheduler] Deleted task '$TaskName'."
