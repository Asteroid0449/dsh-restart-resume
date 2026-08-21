[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DshCliPath,

  [Parameter(Mandatory = $true)]
  [string]$WorkspacePath,

  [string]$ExpectedVersion = '0.1.0-rc.8',

  [ValidateRange(1, 100)]
  [int]$MaxRestarts = 3,

  [ValidateRange(1, 1440)]
  [int]$RestartWindowMinutes = 10
)

$ErrorActionPreference = 'Stop'
$restartExitCode = 75
$restartTimes = [System.Collections.Generic.List[DateTimeOffset]]::new()

$resolvedCli = (Resolve-Path -LiteralPath $DshCliPath -ErrorAction Stop).Path
$resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspacePath -ErrorAction Stop).Path
$runtimeVersion = (& node $resolvedCli --version | Select-Object -First 1).Trim()

if ($LASTEXITCODE -ne 0 -or $runtimeVersion -ne $ExpectedVersion) {
  throw "Refusing to start an unexpected DSH build: expected $ExpectedVersion, got $runtimeVersion"
}

$env:DSH_RESTART_SUPERVISOR = '1'
$env:DSH_RUNTIME_VERSION = $runtimeVersion
Set-Location -LiteralPath $resolvedWorkspace

while ($true) {
  $env:DSH_BOOT_ID = [Guid]::NewGuid().ToString('N')
  Write-Host "Starting DSH $runtimeVersion (boot $($env:DSH_BOOT_ID))..."
  & node $resolvedCli web --no-open
  $exitCode = $LASTEXITCODE

  if ($exitCode -ne $restartExitCode) {
    if ($exitCode -ne 0) {
      Write-Warning "DSH stopped with exit code $exitCode. Automatic relaunch is reserved for exit code $restartExitCode."
    }
    exit $exitCode
  }

  $now = [DateTimeOffset]::Now
  $cutoff = $now.AddMinutes(-$RestartWindowMinutes)
  for ($index = $restartTimes.Count - 1; $index -ge 0; $index--) {
    if ($restartTimes[$index] -lt $cutoff) {
      $restartTimes.RemoveAt($index)
    }
  }

  if ($restartTimes.Count -ge $MaxRestarts) {
    throw "Restart limit exceeded: $MaxRestarts requests within $RestartWindowMinutes minutes."
  }

  $restartTimes.Add($now)
  Start-Sleep -Milliseconds 750
}
