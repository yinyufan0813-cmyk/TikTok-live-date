$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:GMVMAX_DASHBOARD_PORT) { [int]$env:GMVMAX_DASHBOARD_PORT } else { 8787 }
$url = "http://127.0.0.1:$port/live-dashboard.html"

function Test-PortOpen {
  param([string]$HostName, [int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(300, $false)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Find-Chrome {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles(x86)\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
  )
  return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

& (Join-Path $PSScriptRoot "start-chrome-win.ps1")

Start-Process -FilePath "powershell" -WindowStyle Minimized -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-Command", "Set-Location -LiteralPath '$root'; npm run live"
)

if (-not (Test-PortOpen -HostName "127.0.0.1" -Port $port)) {
  $command = "Set-Location -LiteralPath '$root'; node src/dashboard-server.js"
  Start-Process -FilePath "powershell" -WindowStyle Minimized -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-Command", $command
  )
  Start-Sleep -Seconds 1
}

$chrome = Find-Chrome
if ($chrome) {
  Start-Process -FilePath $chrome -ArgumentList @(
    "--app=$url",
    "--window-size=1320,460",
    "--window-position=60,520"
  )
} else {
  Start-Process $url
}

Write-Host "LIVE room dashboard opened: $url"
