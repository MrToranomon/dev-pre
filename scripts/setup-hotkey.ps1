param(
  [string]$Hotkey,
  [string]$DataDirectory = $(if ($env:PERFECTWORK_DATA_DIR) { $env:PERFECTWORK_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "PerfectWork" })
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path $PSScriptRoot -Parent
$agent = Join-Path $PSScriptRoot "perfectwork-hotkey.ps1"
$launcher = Join-Path $projectRoot "launch-perfectwork.vbs"
$configFile = Join-Path $DataDirectory "hotkey.json"
$statusFile = Join-Path $DataDirectory "hotkey-status.json"
New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null

$current = $null
if (Test-Path -LiteralPath $configFile) {
  $current = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
}
$shortcut = if ($Hotkey) { $Hotkey } elseif ($current.shortcut) { $current.shortcut } else { "Win+Insert" }
$config = [ordered]@{
  version = 1; enabled = $true; shortcut = $shortcut; launchScript = $launcher
  updatedAt = [DateTime]::UtcNow.ToString("o")
}
[IO.File]::WriteAllText($configFile, (($config | ConvertTo-Json) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

if (Test-Path -LiteralPath $statusFile) {
  try {
    $oldStatus = Get-Content -Raw -LiteralPath $statusFile | ConvertFrom-Json
    $oldProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($oldStatus.pid)" -ErrorAction SilentlyContinue
    if ($oldProcess -and $oldProcess.CommandLine -like "*$agent*") {
      Stop-Process -Id $oldProcess.ProcessId -Force
      Start-Sleep -Milliseconds 500
    }
  } catch {}
  [IO.File]::Delete($statusFile)
}

$startup = [Environment]::GetFolderPath("Startup")
$shortcutFile = Join-Path $startup "PerfectWork Hotkey.lnk"
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcutFile)
$link.TargetPath = (Join-Path $PSHOME "powershell.exe")
$link.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$agent`" -DataDirectory `"$DataDirectory`""
$link.WorkingDirectory = $projectRoot
$link.WindowStyle = 7
$link.Description = "PerfectWork global hotkey launcher"
$link.Save()

$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$agent`" -DataDirectory `"$DataDirectory`""
Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList $arguments -WindowStyle Hidden

$status = $null
for ($attempt = 0; $attempt -lt 50; $attempt++) {
  Start-Sleep -Milliseconds 200
  try {
    $status = Get-Content -Raw -LiteralPath $statusFile | ConvertFrom-Json
    if ($status.shortcut -eq $shortcut -and ([DateTime]::UtcNow - [DateTime]::Parse($status.updatedAt).ToUniversalTime()).TotalSeconds -lt 5) { break }
  } catch {}
}
if (-not $status -or -not $status.active) {
  throw $(if ($status.error) { $status.error } else { "The PerfectWork hotkey agent did not start." })
}

Write-Output "PerfectWork global hotkey is ready."
Write-Output "Shortcut: $($status.shortcut)"
Write-Output "Startup: $shortcutFile"
