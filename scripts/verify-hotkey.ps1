# Exercise the registered hotkey handler without sending keys to unrelated apps.
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$dataDirectory = Join-Path $env:LOCALAPPDATA 'PerfectWork'
$agentPath = Join-Path $PSScriptRoot 'perfectwork-hotkey.ps1'
$statusFile = Join-Path $dataDirectory 'hotkey-status.json'
$desktopFile = Join-Path $dataDirectory 'desktop-status.json'
$expectedExe = (Resolve-Path (Join-Path $taskRoot 'dist\releases\2.6.0\TigerGate-win32-x64\TigerGate.exe')).Path
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PerfectWorkHotkeyTest {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool PostThreadMessage(uint id, uint message, UIntPtr wParam, IntPtr lParam);
}
"@
function Trigger-PerfectWork {
  $previous = Get-Content -Raw -Encoding UTF8 -LiteralPath $statusFile | ConvertFrom-Json
  if (-not $previous.active -or $previous.shortcut -ne 'Win+Insert') { throw 'Win+Insert is not registered.' }
  $agent = Get-CimInstance Win32_Process -Filter "ProcessId=$($previous.pid)"
  if (-not $agent.CommandLine.Contains($agentPath)) { throw 'Hotkey process does not match this application.' }
  foreach ($thread in (Get-Process -Id $previous.pid).Threads) {
    [void][PerfectWorkHotkeyTest]::PostThreadMessage([uint32]$thread.Id, 0x0312, [UIntPtr]::new([uint32]1), [IntPtr]::new(0x002D0008))
  }
  for ($attempt = 0; $attempt -lt 150; $attempt++) {
    Start-Sleep -Milliseconds 200
    $current = Get-Content -Raw -Encoding UTF8 -LiteralPath $statusFile | ConvertFrom-Json
    if ($current.lastTriggeredAt -ne $previous.lastTriggeredAt -and (Test-Path -LiteralPath $desktopFile)) {
      $desktop = Get-Content -Raw -Encoding UTF8 -LiteralPath $desktopFile | ConvertFrom-Json
      if ($desktop.packaged -and $desktop.visible -and $desktop.executable -eq $expectedExe) {
        $native = Get-Process -Id $desktop.pid -ErrorAction SilentlyContinue
        if ($native -and $native.Path -eq $expectedExe) { return $desktop }
      }
    }
  }
  throw 'The hotkey did not open the packaged application.'
}
$first = Trigger-PerfectWork
Start-Sleep -Milliseconds 1300
$second = Trigger-PerfectWork
for ($attempt = 0; $attempt -lt 30 -and $second.activations -le $first.activations; $attempt++) {
  Start-Sleep -Milliseconds 100
  $second = Get-Content -Raw -Encoding UTF8 -LiteralPath $desktopFile | ConvertFrom-Json
}
if ($first.pid -ne $second.pid -or $second.activations -le $first.activations) { throw 'Second hotkey launch did not reactivate the same window.' }
Write-Output "Win+Insert handler opened TigerGate.exe and reactivated the same app (PID $($second.pid))."
