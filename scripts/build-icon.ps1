$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$env:ELECTRON_RUN_AS_NODE = $null
& (Join-Path $taskRoot 'node_modules\electron\dist\electron.exe') (Join-Path $taskRoot 'desktop\render-icon.cjs') | Out-Default
if ($LASTEXITCODE -ne 0) { throw 'Icon rendering failed.' }
