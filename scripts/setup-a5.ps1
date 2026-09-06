param(
  [string]$ConnectionName = "PerfectWork",
  [string]$A5Workspace = "Workspace",
  [string]$DataDirectory = $(if ($env:PERFECTWORK_DATA_DIR) { $env:PERFECTWORK_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "PerfectWork" })
)

$ErrorActionPreference = "Stop"
if ($ConnectionName -match '[=;\"]' -or $A5Workspace -match '[:;\"]') {
  throw "ConnectionName or A5Workspace contains unsupported characters."
}

$configFile = Join-Path $DataDirectory "database.json"
if (-not (Test-Path -LiteralPath $configFile)) {
  throw "PerfectWork PostgreSQL is not configured. Run npm.cmd run setup:postgres first."
}
$config = Get-Content -Raw -LiteralPath $configFile | ConvertFrom-Json
foreach ($value in @($config.host, $config.port, $config.database, $config.user, $config.schema)) {
  if ([string]$value -match '[;\"]') { throw "The PostgreSQL configuration contains characters unsupported by A5 setup." }
}
$secretFile = Join-Path $DataDirectory $config.secretFile
if (-not (Test-Path -LiteralPath $secretFile)) {
  throw "The PerfectWork PostgreSQL credential file was not found."
}

$package = Get-AppxPackage -Name "176258D837673.A5SQLMk-2" | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw "A5:SQL Mk-2 Microsoft Store edition was not found." }
$executable = Join-Path $package.InstallLocation "A5M2.exe"
if (-not (Test-Path -LiteralPath $executable)) { throw "A5M2.exe was not found." }

$a5Settings = Join-Path $env:LOCALAPPDATA "Packages\$($package.PackageFamilyName)\LocalCache\Roaming\mmatsubara\A5M2(x64)(setting)"
$workspace = Join-Path $a5Settings "Workspace.cini"
if (Test-Path -LiteralPath $workspace) {
  $backupDirectory = Join-Path $DataDirectory "a5-backups"
  New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item -LiteralPath $workspace -Destination (Join-Path $backupDirectory "Workspace.before-perfectwork-$stamp.cini")
}

$secure = (Get-Content -Raw -LiteralPath $secretFile).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

try {
  $connection = "__ConnectionType=Internal;ProviderName=PostgreSQL;SavePassword=True;UseUnicodeMetaData=True;ServerName=$($config.host);Port=$($config.port);Database=$($config.database);UserName=$($config.user);Password=$password;DBType=PostgreSQL;ProtocolVersion=30;SSLMode=Allow;SSLTrustServerCertificate=True;"
  $process = Start-Process -FilePath $executable -ArgumentList @("/Workspace", $A5Workspace, "/NoRestoreSession", "/SetDB", "$ConnectionName=$connection", "/Exit") -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(20000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "A5:SQL Mk-2 did not finish connection registration within 20 seconds."
  }
  if ($process.ExitCode -ne 0) { throw "A5:SQL Mk-2 returned exit code $($process.ExitCode)." }
} finally {
  $password = $null
  $connection = $null
}

$verification = Start-Process -FilePath $executable -ArgumentList @("/Workspace", $A5Workspace, "/NoRestoreSession", "/Connect", $ConnectionName, "/Exit") -WindowStyle Hidden -PassThru
if (-not $verification.WaitForExit(20000)) {
  Stop-Process -Id $verification.Id -Force -ErrorAction SilentlyContinue
  throw "A5:SQL Mk-2 could not verify the PerfectWork connection within 20 seconds."
}
if ($verification.ExitCode -ne 0) { throw "A5:SQL Mk-2 connection verification returned exit code $($verification.ExitCode)." }

Write-Output "A5:SQL Mk-2 connection is ready."
Write-Output "Connection: $ConnectionName"
Write-Output "Database: $($config.database)"
Write-Output "Schema: $($config.schema)"
Write-Output "Connection test: passed"
