$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$port = if ($env:GMVMAX_MOBILE_PORT) { $env:GMVMAX_MOBILE_PORT } else { "8788" }
$hostname = $env:GMVMAX_TAILSCALE_HOSTNAME
$tailscale = "tailscale"

if (-not (Get-Command $tailscale -ErrorAction SilentlyContinue)) {
  throw "Cannot find tailscale. Please install Tailscale and make sure it is available in PATH."
}

$existingServer = Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue
if (-not $existingServer) {
  Write-Host "Starting GMV Max mobile server on port $port..."
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-Command", "cd '$ScriptDir'; `$env:GMVMAX_MOBILE_PORT='$port'; node .\src\mobile-server.js"
  )
  Start-Sleep -Seconds 3
}

if ($hostname) {
  & $tailscale up --hostname=$hostname
} else {
  & $tailscale up
}
& $tailscale funnel --bg --yes $port

Write-Host ""
Write-Host "Mobile panel is running:"
& $tailscale funnel status
