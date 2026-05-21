$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$port = if ($env:GMVMAX_MOBILE_PORT) { $env:GMVMAX_MOBILE_PORT } else { "8788" }

Write-Host "Starting GMV Max mobile server on http://127.0.0.1:$port/"
$env:GMVMAX_MOBILE_PORT = $port
node .\src\mobile-server.js
