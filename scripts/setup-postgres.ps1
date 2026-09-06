param(
  [string]$AdminUser = "postgres",
  [string]$HostName = "127.0.0.1",
  [int]$Port = 5432,
  [string]$Database = "perfectwork",
  [string]$AppUser = "perfectwork_app",
  [string]$DataDirectory = $(if ($env:PERFECTWORK_DATA_DIR) { $env:PERFECTWORK_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "PerfectWork" }),
  [string]$Psql
)

$ErrorActionPreference = "Stop"
if ($Database -notmatch '^[a-zA-Z0-9_]+$' -or $AppUser -notmatch '^[a-zA-Z0-9_]+$') {
  throw "Database and AppUser may contain only letters, numbers, and underscores."
}
if (-not $Psql) {
  $command = Get-Command psql.exe -ErrorAction SilentlyContinue
  if ($command) { $Psql = $command.Source }
  else {
    $version = Get-ChildItem -LiteralPath "C:\Program Files\PostgreSQL" -Directory -ErrorAction SilentlyContinue |
      Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if ($version) {
      $candidate = Join-Path $version.FullName "bin\psql.exe"
      if (Test-Path -LiteralPath $candidate) { $Psql = $candidate }
    }
  }
}
if (-not $Psql -or -not (Test-Path -LiteralPath $Psql)) { throw "psql.exe was not found. Pass -Psql with its full path." }

$existingSecret = Join-Path $DataDirectory "postgres.secret"
if (Test-Path -LiteralPath $existingSecret) {
  $secure = (Get-Content -Raw -LiteralPath $existingSecret).Trim() | ConvertTo-SecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
} else {
  $bytes = New-Object byte[] 36
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
  $password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}
$roleSql = @"
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', '$AppUser', '$password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$AppUser') \gexec
ALTER ROLE "$AppUser" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$password';
"@
$roleSql | & $Psql -X -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $AdminUser -d postgres
if ($LASTEXITCODE -ne 0) { throw "Could not create the PerfectWork PostgreSQL role. Check the PostgreSQL administrator password." }

$databaseSql = @"
SELECT format('CREATE DATABASE %I OWNER %I', '$Database', '$AppUser')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$Database') \gexec
ALTER DATABASE "$Database" OWNER TO "$AppUser";
REVOKE ALL ON DATABASE "$Database" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE "$Database" TO "$AppUser";
"@
$databaseSql | & $Psql -X -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $AdminUser -d postgres
if ($LASTEXITCODE -ne 0) { throw "Could not create the PerfectWork PostgreSQL database." }

New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
$secretFile = Join-Path $DataDirectory "postgres.secret"
$configFile = Join-Path $DataDirectory "database.json"
$secure = ConvertTo-SecureString $password -AsPlainText -Force
$encrypted = ConvertFrom-SecureString $secure
[IO.File]::WriteAllText($secretFile, $encrypted, [Text.UTF8Encoding]::new($false))
$config = [ordered]@{ version = 1; host = $HostName; port = $Port; database = $Database; user = $AppUser; schema = "perfectwork"; ssl = $false; secretFile = "postgres.secret" }
[IO.File]::WriteAllText($configFile, (($config | ConvertTo-Json) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))

foreach ($file in @($secretFile, $configFile)) {
  $acl = Get-Acl -LiteralPath $file
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.WindowsIdentity]::GetCurrent().Name, "FullControl", "Allow")
  $acl.SetAccessRule($rule)
  Set-Acl -LiteralPath $file -AclObject $acl
}

$previousPassword = $env:PGPASSWORD
try {
  $env:PGPASSWORD = $password
  & $Psql -X -v ON_ERROR_STOP=1 -w -h $HostName -p $Port -U $AppUser -d $Database -c "SELECT current_database(), current_user;"
  if ($LASTEXITCODE -ne 0) { throw "The PerfectWork database was created but its application login failed." }
} finally {
  if ($null -eq $previousPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue } else { $env:PGPASSWORD = $previousPassword }
  $password = $null
}

Write-Output "PerfectWork PostgreSQL is ready."
Write-Output "Database: $Database"
Write-Output "Role: $AppUser"
Write-Output "Config: $configFile"
