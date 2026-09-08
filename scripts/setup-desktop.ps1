$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$executable = Join-Path $taskRoot 'dist\releases\2.6.0\TigerGate-win32-x64\TigerGate.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Run npm.cmd run build:desktop first.' }
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $shortcut = Join-Path $folder 'TigerGate.lnk'
  if (Test-Path -LiteralPath $shortcut) {
    $backupFolder = Join-Path $env:LOCALAPPDATA 'PerfectWork\shortcut-backups'
    New-Item -ItemType Directory -Path $backupFolder -Force | Out-Null
    $suffix = if ($folder -eq [Environment]::GetFolderPath('Desktop')) { 'desktop' } else { 'programs' }
    Copy-Item -LiteralPath $shortcut -Destination (Join-Path $backupFolder "PerfectWork-$suffix-$(Get-Date -Format yyyyMMddHHmmss).lnk")
  }
  $link = $shell.CreateShortcut($shortcut)
  $link.TargetPath = $executable
  $link.WorkingDirectory = Split-Path $executable -Parent
  $link.IconLocation = "$executable,0"
  $link.Description = 'TigerGate'
  $link.Save()
  $legacyShortcut = Join-Path $folder 'PerfectWork.lnk'
  if (Test-Path -LiteralPath $legacyShortcut) {
    $legacyTarget = $shell.CreateShortcut($legacyShortcut).TargetPath
    $ownedTargets = @((Join-Path $taskRoot 'dist\PerfectWork-win32-x64\PerfectWork.exe'), (Join-Path $taskRoot 'launch-perfectwork.vbs'))
    if ($legacyTarget -in $ownedTargets) {
      $backupFolder = Join-Path $env:LOCALAPPDATA 'PerfectWork\shortcut-backups'
      New-Item -ItemType Directory -Path $backupFolder -Force | Out-Null
      $suffix = if ($folder -eq [Environment]::GetFolderPath('Desktop')) { 'desktop' } else { 'programs' }
      Move-Item -LiteralPath $legacyShortcut -Destination (Join-Path $backupFolder "PerfectWork-$suffix-$(Get-Date -Format yyyyMMddHHmmssfff).lnk")
    }
  }
  Write-Output $shortcut
}
& (Join-Path $PSScriptRoot 'setup-hotkey.ps1')
