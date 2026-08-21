[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DshCliPath,

  [Parameter(Mandatory = $true)]
  [string]$WorkspacePath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedVersion,

  [ValidateRange(1, 100)]
  [int]$MaxRestarts = 3,

  [ValidateRange(1, 1440)]
  [int]$RestartWindowMinutes = 10
)

$ErrorActionPreference = 'Stop'
$restartExitCode = 75
$restartTimes = [System.Collections.Generic.List[DateTimeOffset]]::new()

function Resolve-DshVersion {
  param([string]$CliPath)
  # No-pipe capture: `| Select-Object -First 1` terminates the pipeline early and
  # ends the upstream node process, which makes $LASTEXITCODE report -1 on
  # Windows PowerShell 5.1 instead of the real exit code. `-join ''` preserves
  # the real exit code and fails to an empty string when node cannot run.
  $version = ((& node $CliPath --version) -join '').Trim()
  if ($LASTEXITCODE -ne 0 -or $version -eq '') {
    throw "Cannot resolve DSH runtime version from $CliPath (node exit code $LASTEXITCODE)"
  }
  return $version
}

$resolvedCli = (Resolve-Path -LiteralPath $DshCliPath -ErrorAction Stop).Path
$resolvedWorkspace = (Resolve-Path -LiteralPath $WorkspacePath -ErrorAction Stop).Path
$runtimeVersion = Resolve-DshVersion -CliPath $resolvedCli

if ($runtimeVersion -ne $ExpectedVersion) {
  throw "Refusing to start an unexpected DSH build: expected $ExpectedVersion, got $runtimeVersion"
}

$env:DSH_RESTART_SUPERVISOR = '1'
$env:DSH_RUNTIME_VERSION = $runtimeVersion
Set-Location -LiteralPath $resolvedWorkspace

while ($true) {
  # Re-verify and re-stamp the version on every launch: the supervisor may
  # outlive a bin.js upgrade/rollback (long-lived process), and each child
  # inherits this process's environment. Without the refresh, dsh_restart_status
  # would keep reporting the boot-time version even though bin.js changed.
  $runtimeVersion = Resolve-DshVersion -CliPath $resolvedCli
  if ($runtimeVersion -ne $ExpectedVersion) {
    throw "Refusing to start an unexpected DSH build: expected $ExpectedVersion, got $runtimeVersion"
  }
  $env:DSH_RUNTIME_VERSION = $runtimeVersion

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
