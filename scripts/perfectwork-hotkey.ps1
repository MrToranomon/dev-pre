param(
  [string]$DataDirectory = $(if ($env:PERFECTWORK_DATA_DIR) { $env:PERFECTWORK_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "PerfectWork" })
)

$ErrorActionPreference = "Stop"
$configFile = Join-Path $DataDirectory "hotkey.json"
$statusFile = Join-Path $DataDirectory "hotkey-status.json"
$created = $false
$mutex = [Threading.Mutex]::new($true, "Local\PerfectWorkHotkeyAgent", [ref]$created)
if (-not $created) { exit 0 }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PerfectWorkHotKeyNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MSG {
    public IntPtr hwnd; public uint message; public UIntPtr wParam;
    public IntPtr lParam; public uint time; public POINT pt; public uint lPrivate;
  }
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")]
  public static extern bool PeekMessage(out MSG message, IntPtr hWnd, uint min, uint max, uint remove);
}
"@

$script:registered = $false
$script:activeShortcut = $null
$script:launcher = $null
$script:lastTriggeredAt = $null
$script:lastTrigger = [DateTime]::MinValue
$script:lastError = $null

function ConvertTo-HotKey([string]$shortcut) {
  $modifiers = [uint32]0x4000 # MOD_NOREPEAT
  $key = $null
  foreach ($part in ($shortcut -split '\+')) {
    $token = $part.Trim()
    $lower = $token.ToLowerInvariant()
    if ($lower -eq "win") { $modifiers = $modifiers -bor 0x0008; continue }
    if ($lower -eq "ctrl") { $modifiers = $modifiers -bor 0x0002; continue }
    if ($lower -eq "alt") { $modifiers = $modifiers -bor 0x0001; continue }
    if ($lower -eq "shift") { $modifiers = $modifiers -bor 0x0004; continue }
    if ($null -ne $key) { throw "Only one non-modifier key may be used." }
    $names = @{
      "insert"=0x2D; "delete"=0x2E; "home"=0x24; "end"=0x23
      "pageup"=0x21; "pagedown"=0x22; "space"=0x20; "enter"=0x0D
      "escape"=0x1B; "tab"=0x09; "backspace"=0x08; "up"=0x26
      "down"=0x28; "left"=0x25; "right"=0x27; "pause"=0x13
      "scrolllock"=0x91; "printscreen"=0x2C
    }
    if ($names.ContainsKey($lower)) { $key = [uint32]$names[$lower] }
    elseif ($token -match '^[A-Z0-9]$') { $key = [uint32][char]$token.ToUpperInvariant() }
    elseif ($token -match '^F([1-9]|1[0-9]|2[0-4])$') { $key = [uint32](0x70 + [int]$Matches[1] - 1) }
    else { throw "Unsupported hotkey: $token" }
  }
  if ($null -eq $key) { throw "The hotkey has no key." }
  return @{ Modifiers = $modifiers; Key = $key }
}

function Write-HotKeyStatus([bool]$active, [string]$shortcut, [string]$errorMessage) {
  $document = [ordered]@{
    version = 1; pid = $PID; active = $active; shortcut = $shortcut
    error = $(if ($errorMessage) { $errorMessage } else { $null })
    lastTriggeredAt = $script:lastTriggeredAt
    updatedAt = [DateTime]::UtcNow.ToString("o")
  }
  $temporary = "$statusFile.$PID.tmp"
  [IO.File]::WriteAllText($temporary, (($document | ConvertTo-Json) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $statusFile -Force
}

function Reload-HotKey {
  if ($script:registered) {
    [void][PerfectWorkHotKeyNative]::UnregisterHotKey([IntPtr]::Zero, 1)
    $script:registered = $false
  }
  try {
    $config = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
    $script:activeShortcut = [string]$config.shortcut
    $script:launcher = [string]$config.launchScript
    if (-not $config.enabled) {
      $script:lastError = $null
      Write-HotKeyStatus $false $script:activeShortcut $null
      return
    }
    if (-not (Test-Path -LiteralPath $script:launcher -PathType Leaf) -or [IO.Path]::GetExtension($script:launcher) -ne ".vbs") {
      throw "PerfectWork launcher was not found."
    }
    $parsed = ConvertTo-HotKey $script:activeShortcut
    if (-not [PerfectWorkHotKeyNative]::RegisterHotKey([IntPtr]::Zero, 1, $parsed.Modifiers, $parsed.Key)) {
      throw "The shortcut is already used by Windows or another application."
    }
    $script:registered = $true
    $script:lastError = $null
    Write-HotKeyStatus $true $script:activeShortcut $null
  } catch {
    $script:lastError = $_.Exception.Message
    Write-HotKeyStatus $false $script:activeShortcut $script:lastError
  }
}

try {
  $lastStamp = 0
  $lastHeartbeat = [DateTime]::MinValue
  while ($true) {
    if (Test-Path -LiteralPath $configFile) {
      $stamp = (Get-Item -LiteralPath $configFile).LastWriteTimeUtc.Ticks
      if ($stamp -ne $lastStamp) {
        $lastStamp = $stamp
        Reload-HotKey
      }
    }
    $message = New-Object PerfectWorkHotKeyNative+MSG
    while ([PerfectWorkHotKeyNative]::PeekMessage([ref]$message, [IntPtr]::Zero, 0, 0, 1)) {
      if ($message.message -eq 0x0312 -and $script:registered -and ([DateTime]::UtcNow - $script:lastTrigger).TotalSeconds -gt 1) {
        $script:lastTrigger = [DateTime]::UtcNow
        $script:lastTriggeredAt = $script:lastTrigger.ToString("o")
        $launchArguments = "//nologo `"$($script:launcher)`""
        Start-Process -FilePath (Join-Path $env:WINDIR "System32\wscript.exe") -ArgumentList $launchArguments -WindowStyle Hidden
        Write-HotKeyStatus $true $script:activeShortcut $null
      }
    }
    if (([DateTime]::UtcNow - $lastHeartbeat).TotalSeconds -ge 5) {
      Write-HotKeyStatus $script:registered $script:activeShortcut $script:lastError
      $lastHeartbeat = [DateTime]::UtcNow
    }
    Start-Sleep -Milliseconds 75
  }
} finally {
  if ($script:registered) { [void][PerfectWorkHotKeyNative]::UnregisterHotKey([IntPtr]::Zero, 1) }
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
