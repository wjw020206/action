param(
  [string]$TaskName = "Update IPTV",
  [string]$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$IntervalHours = 1,
  [switch]$RunNow
)

$ErrorActionPreference = "Stop"

function Find-OptionalCommandPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) {
    return $command.Source
  }

  return $null
}

function Test-ProjectFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    throw "Required file not found: $Path"
  }
}

$ProjectDir = (Resolve-Path $ProjectDir).Path
$TaskCommand = Find-OptionalCommandPath "pnpm.cmd"
$TaskArgument = "run update-iptv"

if (-not $TaskCommand) {
  $TaskCommand = Find-OptionalCommandPath "corepack.cmd"
  $TaskArgument = "pnpm run update-iptv"
}

if (-not $TaskCommand) {
  throw "Command not found: pnpm.cmd or corepack.cmd. Please install Node.js and enable Corepack first."
}

Test-ProjectFile (Join-Path $ProjectDir "package.json")
Test-ProjectFile (Join-Path $ProjectDir "src\update-iptv.js")
Test-ProjectFile (Join-Path $ProjectDir ".env")

$Action = New-ScheduledTaskAction `
  -Execute $TaskCommand `
  -Argument $TaskArgument `
  -WorkingDirectory $ProjectDir

$Trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$Settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -WakeToRun

$Principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType InteractiveToken `
  -RunLevel LeastPrivilege

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description "每小时更新 IPTV 并上传到腾讯 COS" `
  -Force | Out-Null

Write-Host "Task registered: $TaskName"
Write-Host "Project directory: $ProjectDir"
Write-Host "Command: $TaskCommand $TaskArgument"
Write-Host "Interval: every $IntervalHours hour(s)"

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Task started: $TaskName"
}
